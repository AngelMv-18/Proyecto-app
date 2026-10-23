import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, rows, withTx } from '../db.js';
import { AppError, badRequest, unauthorized } from '../errors.js';
import { hashPassword, loginFailed, loginOk, loginThrottle, newToken, sha256, verifyPassword } from '../security.js';
import { audit } from '../audit.js';
import { seedUser } from '../seed.js';
import { parse, uid } from '../http.js';
import { DEFAULT_ALERT_PREFS } from '../services/alerts.js';

const COOKIE = 'nova_session';
const pwd = z.string().min(10, 'Mínimo 10 caracteres').max(200);

async function startSession(app: FastifyInstance, req: any, reply: any, userId: string) {
  const token = newToken();
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES ($1,$2, now() + ($3 || \' days\')::interval, $4)', [sha256(token), userId, String(config.sessionDays), String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: config.sessionDays * 86400 });
}

const publicUser = (u: any) => ({ id: u.id, email: u.email, display_name: u.display_name, currency: u.currency, timezone: u.timezone, locale: u.locale, settings: { ...u.settings, alerts: { ...DEFAULT_ALERT_PREFS, ...(u.settings?.alerts ?? {}) } } });

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async () => {
    const n = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM users'))!.n;
    return { has_users: n > 0, registration_open: n === 0 || config.allowRegistration };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().toLowerCase(), password: pwd, display_name: z.string().trim().min(1).max(80), currency: z.string().length(3).toUpperCase().default('HNL') }), req.body);
    const n = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM users'))!.n;
    if (n > 0 && !config.allowRegistration) throw new AppError(403, 'registration_closed', 'El registro está cerrado en esta instalación');
    const hash = await hashPassword(b.password);
    const u = await withTx(async (c) => {
      const exists = await one(c, 'SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (exists) throw new AppError(409, 'email_taken', 'Ya existe una cuenta con ese correo');
      const u = await one(c, 'INSERT INTO users(email,display_name,password_hash,currency) VALUES ($1,$2,$3,$4) RETURNING *', [b.email, b.display_name, hash, b.currency]);
      await seedUser(c, u.id);
      await audit(c, u.id, 'user', u.id, 'register');
      return u;
    });
    await startSession(app, req, reply, u.id);
    return publicUser(u);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1).max(200) }), req.body);
    const key = `${req.ip}|${b.email}`;
    const th = loginThrottle(key);
    if (th.blocked) throw new AppError(429, 'too_many_attempts', `Demasiados intentos. Intenta de nuevo en ${Math.ceil(th.retryInSec / 60)} min.`);
    const u = await one(pool, 'SELECT * FROM users WHERE email=$1', [b.email]);
    // Se verifica siempre un hash para no revelar por tiempo si el correo existe.
    const ok = u ? await verifyPassword(b.password, u.password_hash) : (await verifyPassword(b.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='), false);
    if (!u || !ok) { loginFailed(key); await audit(pool, u?.id ?? null, 'user', u?.id ?? null, 'login_failed'); throw unauthorized('Correo o contraseña incorrectos'); }
    loginOk(key);
    await startSession(app, req, reply, u.id);
    await audit(pool, u.id, 'user', u.id, 'login');
    return publicUser(u);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(t)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [uid(req)]);
    return publicUser(u);
  });

  app.patch('/api/me', async (req) => {
    const b = parse(z.object({
      display_name: z.string().trim().min(1).max(80).optional(),
      currency: z.string().length(3).toUpperCase().optional(),
      timezone: z.string().max(60).optional(),
      locale: z.string().max(10).optional(),
      settings: z.object({
        alerts: z.object({
          budget: z.boolean(), large_expense_limit: z.number().int().positive().nullable(), low_balance: z.boolean(), subscriptions: z.boolean(),
          goals: z.boolean(), review: z.boolean(), duplicates: z.boolean(), reconciliation: z.boolean(), unusual: z.boolean(),
        }).partial().optional(),
        ingest_account_id: z.string().uuid().nullable().optional(),
      }).optional(),
    }), req.body);
    if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw badRequest('Zona horaria no válida'); } }
    const cur = await one(pool, 'SELECT * FROM users WHERE id=$1', [uid(req)]);
    const settings = { ...cur.settings, ...(b.settings ?? {}), alerts: { ...(cur.settings?.alerts ?? {}), ...(b.settings?.alerts ?? {}) } };
    if (b.currency && b.currency !== cur.currency) {
      const used = await one(pool, 'SELECT 1 FROM transactions WHERE user_id=$1 LIMIT 1', [uid(req)]);
      if (used) throw badRequest('Cambiar la moneda principal con movimientos registrados no está soportado: crea cuentas en la otra moneda en su lugar', 'currency_locked');
    }
    const u = await one(pool, 'UPDATE users SET display_name=COALESCE($2,display_name), currency=COALESCE($3,currency), timezone=COALESCE($4,timezone), locale=COALESCE($5,locale), settings=$6 WHERE id=$1 RETURNING *', [uid(req), b.display_name, b.currency, b.timezone, b.locale, JSON.stringify(settings)]);
    await audit(pool, uid(req), 'user', uid(req), 'update_profile');
    return publicUser(u);
  });

  app.post('/api/me/password', async (req) => {
    const b = parse(z.object({ current: z.string().min(1), next: pwd }), req.body);
    const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [uid(req)]);
    if (!(await verifyPassword(b.current, u.password_hash))) throw new AppError(403, 'wrong_password', 'La contraseña actual no es correcta');
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await hashPassword(b.next)]);
    // Cierra las demás sesiones.
    const cur = sha256((req.cookies as any)[COOKIE] ?? '');
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [u.id, cur]);
    await audit(pool, u.id, 'user', u.id, 'change_password');
    return { ok: true };
  });

  app.get('/api/me/sessions', async (req) => rows(pool, 'SELECT created_at, expires_at, user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC', [uid(req)]));
}
