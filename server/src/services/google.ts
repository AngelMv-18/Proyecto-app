import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { Db, one } from '../db.js';
import { AppError } from '../errors.js';
import { newToken, sha256 } from '../security.js';

/** Inicio de sesión con Google solo necesita las credenciales OAuth (alcances básicos: openid, email, profile). */
export const googleLoginConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);
export const googleLoginRedirect = () => `${config.publicUrl}/api/auth/google/callback`;

export async function newOAuthState(db: Db, data: object) {
  const token = newToken(24);
  await db.query(`INSERT INTO oauth_states(state_hash,data,expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [sha256(token), JSON.stringify(data)]);
  await db.query(`DELETE FROM oauth_states WHERE expires_at < now()`);
  return token;
}
/** Un solo uso: se borra al leerlo. */
export async function takeOAuthState<T = any>(db: Db, token: string): Promise<T | null> {
  const r = await one<{ data: T }>(db, `DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at > now() RETURNING data`, [sha256(token)]);
  return r?.data ?? null;
}

export async function googleLoginUrl(db: Db, o: { invite?: string | null }) {
  if (!googleLoginConfigured()) throw new AppError(412, 'not_configured', 'El acceso con Google no está configurado (faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)');
  const nonce = newToken(16);
  const state = await newOAuthState(db, { kind: 'login', invite: o.invite ?? null, nonce });
  const p = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: googleLoginRedirect(), response_type: 'code',
    scope: 'openid email profile', state, nonce, prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export type GoogleIdentity = { sub: string; email: string; name: string };

/**
 * Intercambia el código por tokens directamente con Google (TLS + secreto del cliente). Según OpenID Connect §3.1.3.7,
 * un ID token recibido así puede validarse por sus claims sin verificar la firma; se comprueban iss, aud, exp, nonce y email_verified.
 */
export async function exchangeGoogleCode(code: string, nonce: string, f: typeof fetch = fetch): Promise<GoogleIdentity> {
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: googleLoginRedirect(), grant_type: 'authorization_code' }),
  });
  const tok: any = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new AppError(502, 'oauth_failed', 'Google no completó el inicio de sesión');
  let c: any;
  try { c = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()); } catch { throw new AppError(502, 'oauth_failed', 'Respuesta de Google inválida'); }
  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== config.google.clientId || !(c.exp > now) || c.nonce !== nonce) throw new AppError(401, 'oauth_invalid', 'El inicio de sesión con Google no es válido');
  if (!c.email || c.email_verified !== true) throw new AppError(403, 'email_unverified', 'Tu correo de Google no está verificado');
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: String(c.name ?? c.given_name ?? c.email.split('@')[0]).slice(0, 80) };
}

export const avatarSeed = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
