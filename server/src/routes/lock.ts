import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { webauthnRp } from '../config.js';
import { one, pool, rows } from '../db.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { rateBlocked, rateClear, rateHit, sha256, verifyPassword } from '../security.js';
import { appName } from './brand.js';

export const DEFAULT_LOCK = { enabled: false, timeout_min: 1 };
export const lockPrefs = (settings: any) => ({ ...DEFAULT_LOCK, ...(settings?.lock ?? {}) });

/** Marca la sesión como desbloqueada durante el tiempo configurado. */
export async function unlockSession(tokenHash: string, timeoutMin: number) {
  await pool.query(`UPDATE sessions SET unlocked_until = now() + make_interval(mins => $2), challenge = NULL, challenge_expires = NULL WHERE token_hash=$1`, [tokenHash, timeoutMin]);
}

const sessionHash = (req: any) => sha256(req.cookies?.nova_session ?? '');

async function setChallenge(req: any, challenge: string) {
  await pool.query(`UPDATE sessions SET challenge=$2, challenge_expires = now() + interval '5 minutes' WHERE token_hash=$1`, [sessionHash(req), challenge]);
}
async function takeChallenge(req: any): Promise<string> {
  const r = await one<{ challenge: string | null }>(pool, `UPDATE sessions s SET challenge=NULL, challenge_expires=NULL FROM (SELECT challenge, challenge_expires FROM sessions WHERE token_hash=$1) old
       WHERE s.token_hash=$1 RETURNING CASE WHEN old.challenge_expires > now() THEN old.challenge END AS challenge`, [sessionHash(req)]);
  if (!r?.challenge) throw badRequest('El desafío venció. Inténtalo de nuevo.', 'challenge_expired');
  return r.challenge;
}

// Respuesta de WebAuthn: estructura validada por la librería; aquí solo se limita el tamaño.
const credentialJson = z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.record(z.any()) }).passthrough();

export async function lockRoutes(app: FastifyInstance) {
  // Estado del bloqueo (permitido aun con la sesión bloqueada, para mostrar la pantalla de desbloqueo).
  app.get('/api/lock/status', async (req) => {
    const u = await one(pool, 'SELECT display_name, settings FROM users WHERE id=$1', [uid(req)]);
    const s = await one(pool, 'SELECT unlocked_until FROM sessions WHERE token_hash=$1', [sessionHash(req)]);
    const creds = await rows(pool, 'SELECT id, label, created_at, last_used_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at', [uid(req)]);
    const p = lockPrefs(u.settings);
    return { ...p, display_name: u.display_name, locked: p.enabled && !(s?.unlocked_until && new Date(s.unlocked_until) > new Date()), credentials: creds.map((c) => ({ id: c.id.slice(0, 12), full_id: c.id, label: c.label, created_at: c.created_at, last_used_at: c.last_used_at })) };
  });

  // ---- Registrar la huella de este dispositivo (requiere sesión desbloqueada) ----
  app.post('/api/lock/register/options', async (req) => {
    const u = await one(pool, 'SELECT id, email, display_name FROM users WHERE id=$1', [uid(req)]);
    const existing = await rows(pool, 'SELECT id, transports FROM webauthn_credentials WHERE user_id=$1', [uid(req)]);
    const { rpID } = webauthnRp();
    const opts = await generateRegistrationOptions({
      rpName: await appName(), rpID, userName: u.email, userDisplayName: u.display_name,
      userID: new TextEncoder().encode(u.id), attestationType: 'none', timeout: 60_000,
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      // Autenticador del propio teléfono (huella, rostro o bloqueo de pantalla), con verificación del usuario obligatoria.
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    });
    await setChallenge(req, opts.challenge);
    return opts;
  });

  app.post('/api/lock/register/verify', async (req) => {
    const b = parse(z.object({ response: credentialJson, label: z.string().trim().max(60).optional() }), req.body);
    const expectedChallenge = await takeChallenge(req);
    const { rpID, origin } = webauthnRp();
    let v;
    try {
      v = await verifyRegistrationResponse({ response: b.response as any, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e: any) { throw badRequest(`No se pudo verificar la huella: ${e?.message ?? 'respuesta inválida'}`, 'webauthn_failed'); }
    if (!v.verified || !v.registrationInfo) throw badRequest('No se pudo verificar la huella', 'webauthn_failed');
    const c = v.registrationInfo.credential;
    await pool.query(`INSERT INTO webauthn_credentials(id,user_id,public_key,counter,transports,label) VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.id, uid(req), Buffer.from(c.publicKey), c.counter, c.transports ?? [], b.label || 'Este dispositivo']);
    // Al registrar la primera huella se activa el bloqueo.
    const u = await one(pool, 'SELECT settings FROM users WHERE id=$1', [uid(req)]);
    const lock = { ...lockPrefs(u.settings), enabled: true };
    await pool.query('UPDATE users SET settings = jsonb_set(settings, \'{lock}\', $2::jsonb) WHERE id=$1', [uid(req), JSON.stringify(lock)]);
    await unlockSession(sessionHash(req), lock.timeout_min);
    await audit(pool, uid(req), 'lock', null, 'credential_added', null, { label: b.label });
    return { ok: true, lock };
  });

  // ---- Desbloquear (permitido con la sesión bloqueada) ----
  app.post('/api/lock/unlock/options', async (req) => {
    const creds = await rows(pool, 'SELECT id, transports FROM webauthn_credentials WHERE user_id=$1', [uid(req)]);
    if (!creds.length) throw new AppError(409, 'no_credentials', 'No hay huella registrada: desbloquea con tu contraseña');
    const opts = await generateAuthenticationOptions({ rpID: webauthnRp().rpID, userVerification: 'required', timeout: 60_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })) });
    await setChallenge(req, opts.challenge);
    return opts;
  });

  app.post('/api/lock/unlock/verify', async (req) => {
    const key = `unlock:${uid(req)}`;
    const th = await rateBlocked(pool, key, 10, 900);
    if (th.blocked) throw new AppError(429, 'too_many_attempts', 'Demasiados intentos. Usa tu contraseña o espera unos minutos.');
    const b = parse(z.object({ response: credentialJson }), req.body);
    const cred = await one(pool, 'SELECT * FROM webauthn_credentials WHERE id=$1 AND user_id=$2', [b.response.id, uid(req)]);
    if (!cred) { await rateHit(pool, key, 900); throw new AppError(401, 'unknown_credential', 'Esta huella no está registrada para tu usuario'); }
    const expectedChallenge = await takeChallenge(req);
    const { rpID, origin } = webauthnRp();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: b.response as any, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: cred.transports },
      });
    } catch (e: any) { await rateHit(pool, key, 900); throw new AppError(401, 'webauthn_failed', 'No se pudo verificar la huella'); }
    if (!v.verified) { await rateHit(pool, key, 900); throw new AppError(401, 'webauthn_failed', 'No se pudo verificar la huella'); }
    await pool.query('UPDATE webauthn_credentials SET counter=$2, last_used_at=now() WHERE id=$1', [cred.id, v.authenticationInfo.newCounter]);
    const u = await one(pool, 'SELECT settings FROM users WHERE id=$1', [uid(req)]);
    await unlockSession(sessionHash(req), lockPrefs(u.settings).timeout_min);
    await rateClear(pool, key);
    await audit(pool, uid(req), 'lock', null, 'unlocked_biometric');
    return { ok: true };
  });

  app.post('/api/lock/unlock/password', async (req) => {
    const key = `unlockpw:${uid(req)}`;
    const th = await rateBlocked(pool, key, 5, 900);
    if (th.blocked) throw new AppError(429, 'too_many_attempts', `Demasiados intentos. Espera ${Math.ceil(th.retryInSec / 60)} min.`);
    const b = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const u = await one(pool, 'SELECT password_hash, settings FROM users WHERE id=$1', [uid(req)]);
    if (!(await verifyPassword(b.password, u.password_hash))) { await rateHit(pool, key, 900); throw new AppError(401, 'wrong_password', 'Contraseña incorrecta'); }
    await rateClear(pool, key);
    await unlockSession(sessionHash(req), lockPrefs(u.settings).timeout_min);
    await audit(pool, uid(req), 'lock', null, 'unlocked_password');
    return { ok: true };
  });

  // ---- Ajustes (requiere sesión desbloqueada) ----
  app.patch('/api/lock/settings', async (req) => {
    const b = parse(z.object({ enabled: z.boolean().optional(), timeout_min: z.number().int().refine((n) => [1, 5, 15, 60].includes(n), 'Usa 1, 5, 15 o 60 minutos').optional() }), req.body);
    const u = await one(pool, 'SELECT settings FROM users WHERE id=$1', [uid(req)]);
    const lock = { ...lockPrefs(u.settings), ...b };
    if (lock.enabled) {
      const n = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM webauthn_credentials WHERE user_id=$1', [uid(req)]))!.n;
      if (!n) throw badRequest('Primero registra la huella de este dispositivo', 'no_credentials');
    }
    await pool.query('UPDATE users SET settings = jsonb_set(settings, \'{lock}\', $2::jsonb) WHERE id=$1', [uid(req), JSON.stringify(lock)]);
    await unlockSession(sessionHash(req), lock.timeout_min);
    await audit(pool, uid(req), 'lock', null, 'settings', null, lock);
    return lock;
  });

  app.delete('/api/lock/credentials/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(4).max(1024) }), req.params);
    const r = await pool.query('DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2', [id, uid(req)]);
    if (!r.rowCount) throw notFound('Huella');
    const left = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM webauthn_credentials WHERE user_id=$1', [uid(req)]))!.n;
    if (!left) await pool.query(`UPDATE users SET settings = jsonb_set(settings, '{lock}', (COALESCE(settings->'lock','{}'::jsonb) || '{"enabled":false}'::jsonb)) WHERE id=$1`, [uid(req)]);
    await audit(pool, uid(req), 'lock', null, 'credential_removed');
    return { ok: true, remaining: left };
  });
}
