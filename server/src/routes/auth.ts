import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, rows, withTx } from '../db.js';
import { AppError, badRequest, unauthorized } from '../errors.js';
import { hashPassword, newToken, openTotp, rateBlocked, rateClear, rateHit, sealTotp, sha256, verifyPassword } from '../security.js';
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../services/totp.js';
import QRCode from 'qrcode';
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
    return { has_users: n > 0, registration_open: n === 0 || config.allowRegistration, requires_code: Boolean(config.registrationCode) };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().toLowerCase(), password: pwd, display_name: z.string().trim().min(1).max(80), currency: z.string().length(3).toUpperCase().default('HNL'), code: z.string().max(200).optional() }), req.body);
    if (config.registrationCode) {
      const { timingSafeEqual } = await import('node:crypto');
      const a = Buffer.from(sha256(b.code ?? '')), e = Buffer.from(sha256(config.registrationCode));
      if (!timingSafeEqual(a, e)) throw new AppError(403, 'bad_registration_code', 'Código de instalación incorrecto');
    }
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
    const key = `login:${req.ip}|${b.email}`;
    const th = await rateBlocked(pool, key, 8, 900);
    if (th.blocked) throw new AppError(429, 'too_many_attempts', `Demasiados intentos. Intenta de nuevo en ${Math.ceil(th.retryInSec / 60)} min.`);
    const u = await one(pool, 'SELECT * FROM users WHERE email=$1', [b.email]);
    // Se verifica siempre un hash para no revelar por tiempo si el correo existe.
    const ok = u ? await verifyPassword(b.password, u.password_hash) : (await verifyPassword(b.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='), false);
    if (!u || !ok) { await rateHit(pool, key, 900); await audit(pool, u?.id ?? null, 'user', u?.id ?? null, 'login_failed'); throw unauthorized('Correo o contraseña incorrectos'); }
    await rateClear(pool, key);
    if (u.totp_enabled) {
      // Segundo paso: se entrega un ticket de un solo uso; la sesión solo se crea tras validar el código.
      const ticket = newToken();
      await pool.query(`INSERT INTO login_tickets(token_hash,user_id,expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [sha256(ticket), u.id]);
      return { two_factor_required: true, ticket };
    }
    await startSession(app, req, reply, u.id);
    await audit(pool, u.id, 'user', u.id, 'login');
    return publicUser(u);
  });

  app.post('/api/auth/login/2fa', async (req, reply) => {
    const b = parse(z.object({ ticket: z.string().min(10).max(100), code: z.string().trim().min(6).max(20) }), req.body);
    const t = await one(pool, `UPDATE login_tickets SET attempts = attempts + 1 WHERE token_hash=$1 AND expires_at > now() RETURNING *`, [sha256(b.ticket)]);
    if (!t || t.attempts > 5) { if (t) await pool.query('DELETE FROM login_tickets WHERE token_hash=$1', [sha256(b.ticket)]); throw unauthorized('El paso de verificación venció. Inicia sesión de nuevo.'); }
    const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [t.user_id]);
    let ok = false;
    const step = u.totp_secret ? verifyTotp(openTotp(u.totp_secret), b.code, u.totp_last_step) : null;
    if (step != null) { ok = true; await pool.query('UPDATE users SET totp_last_step=$2 WHERE id=$1', [u.id, step]); }
    else {
      const rc = await one(pool, `UPDATE recovery_codes SET used_at=now() WHERE id = (SELECT id FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL AND code_hash=$2 LIMIT 1) RETURNING id`, [u.id, sha256(b.code.toUpperCase().replace(/[\s-]/g, ''))]);
      if (rc) { ok = true; await audit(pool, u.id, 'user', u.id, 'recovery_code_used'); }
    }
    if (!ok) { await audit(pool, u.id, 'user', u.id, 'login_2fa_failed'); throw unauthorized('Código incorrecto'); }
    await pool.query('DELETE FROM login_tickets WHERE token_hash=$1 OR expires_at < now()', [sha256(b.ticket)]);
    await startSession(app, req, reply, u.id);
    await audit(pool, u.id, 'user', u.id, 'login');
    return publicUser(u);
  });

  // ---------- Verificación en dos pasos ----------
  app.get('/api/me/2fa', async (req) => {
    const u = await one(pool, 'SELECT totp_enabled, totp_secret FROM users WHERE id=$1', [uid(req)]);
    const left = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL', [uid(req)]))!.n;
    return { enabled: u.totp_enabled, recovery_remaining: left, secret_encrypted: Boolean(u.totp_secret?.startsWith('enc:')) || (!u.totp_secret && Boolean(config.encryptionKey)) };
  });
  const needPassword = async (userId: string, password: string) => {
    const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [userId]);
    if (!(await verifyPassword(password, u.password_hash))) throw new AppError(403, 'wrong_password', 'Contraseña incorrecta');
    return u;
  };
  app.post('/api/me/2fa/setup', async (req) => {
    const b = parse(z.object({ password: z.string().min(1) }), req.body);
    const u = await needPassword(uid(req), b.password);
    if (u.totp_enabled) throw new AppError(409, 'already_enabled', 'La verificación en dos pasos ya está activa');
    const secret = newTotpSecret();
    await pool.query('UPDATE users SET totp_secret=$2, totp_last_step=NULL WHERE id=$1', [u.id, sealTotp(secret)]);
    const uri = otpauthUri(secret, u.email);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B0D10', light: '#FFFFFF' } });
    return { secret, uri, qr_svg: qr };
  });
  app.post('/api/me/2fa/enable', async (req) => {
    const b = parse(z.object({ code: z.string().trim() }), req.body);
    const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [uid(req)]);
    if (!u.totp_secret) throw badRequest('Primero genera el código QR');
    if (u.totp_enabled) throw new AppError(409, 'already_enabled', 'Ya está activa');
    const step = verifyTotp(openTotp(u.totp_secret), b.code, null);
    if (step == null) throw badRequest('Código incorrecto. Revisa la hora de tu teléfono.', 'bad_code', { code: 'Código incorrecto' });
    const codes = newRecoveryCodes();
    await withTx(async (c) => {
      await c.query('UPDATE users SET totp_enabled=true, totp_last_step=$2 WHERE id=$1', [u.id, step]);
      await c.query('DELETE FROM recovery_codes WHERE user_id=$1', [u.id]);
      for (const code of codes) await c.query('INSERT INTO recovery_codes(user_id,code_hash) VALUES ($1,$2)', [u.id, sha256(code.replace('-', ''))]);
      await audit(c, u.id, 'user', u.id, '2fa_enabled');
    });
    return { enabled: true, recovery_codes: codes };
  });
  app.post('/api/me/2fa/disable', async (req) => {
    const b = parse(z.object({ password: z.string().min(1), code: z.string().trim() }), req.body);
    const u = await needPassword(uid(req), b.password);
    if (!u.totp_enabled) return { enabled: false };
    if (verifyTotp(openTotp(u.totp_secret), b.code, u.totp_last_step) == null) throw badRequest('Código incorrecto', 'bad_code', { code: 'Código incorrecto' });
    await withTx(async (c) => {
      await c.query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [u.id]);
      await c.query('DELETE FROM recovery_codes WHERE user_id=$1', [u.id]);
      await audit(c, u.id, 'user', u.id, '2fa_disabled');
    });
    return { enabled: false };
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
        push: z.object({ enabled: z.boolean(), private: z.boolean(), min_severity: z.enum(['info', 'warning', 'critical']) }).partial().optional(),
        digests: z.object({ daily: z.boolean(), weekly: z.boolean(), monthly: z.boolean() }).partial().optional(),
      }).optional(),
    }), req.body);
    if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw badRequest('Zona horaria no válida'); } }
    const cur = await one(pool, 'SELECT * FROM users WHERE id=$1', [uid(req)]);
    const settings = { ...cur.settings, ...(b.settings ?? {}), alerts: { ...(cur.settings?.alerts ?? {}), ...(b.settings?.alerts ?? {}) }, push: { ...(cur.settings?.push ?? {}), ...(b.settings?.push ?? {}) }, digests: { ...(cur.settings?.digests ?? {}), ...(b.settings?.digests ?? {}) } };
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
