import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const key = await scrypt(password, Buffer.from(s, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// Cifrado en reposo de tokens OAuth (AES-256-GCM). La clave solo vive en el entorno del servidor.
export function encryptSecret(plain: string): string {
  if (!config.encryptionKey) throw new Error('APP_ENCRYPTION_KEY no configurada');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decryptSecret(blob: string): string {
  if (!config.encryptionKey) throw new Error('APP_ENCRYPTION_KEY no configurada');
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Limitador de intentos persistente en PostgreSQL (funciona con varias réplicas y tras reinicios).
import type { Db } from './db.js';
export async function rateBlocked(db: Db, key: string, max: number, windowSec: number): Promise<{ blocked: boolean; retryInSec: number }> {
  const r = (await db.query(`SELECT hits, EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now()))::int AS left FROM rate_limits WHERE key=$1 AND window_start > now() - make_interval(secs => $2)`, [key, windowSec])).rows[0];
  return r && r.hits >= max ? { blocked: true, retryInSec: Math.max(r.left, 1) } : { blocked: false, retryInSec: 0 };
}
export async function rateHit(db: Db, key: string, windowSec: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO rate_limits(key,hits,window_start) VALUES ($1,1,now())
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING hits`, [key, windowSec]);
  return r.rows[0].hits;
}
export async function rateClear(db: Db, key: string) { await db.query('DELETE FROM rate_limits WHERE key=$1', [key]); }
/** Lanza 429 si se supera el máximo en la ventana; si no, cuenta el intento. */
export async function rateLimit(db: Db, key: string, max: number, windowSec: number) {
  const n = await rateHit(db, key, windowSec);
  if (n > max) { const { AppError } = await import('./errors.js'); throw new AppError(429, 'rate_limited', 'Demasiadas solicitudes. Espera un momento.'); }
}
export async function resetThrottle(db?: Db) { if (db) await db.query('DELETE FROM rate_limits'); }

// Secreto TOTP en reposo: cifrado si hay APP_ENCRYPTION_KEY; si no, se guarda marcado (y se advierte en la interfaz).
export const sealTotp = (secret: string) => (config.encryptionKey ? `enc:${encryptSecret(secret)}` : `plain:${secret}`);
export const openTotp = (stored: string) => (stored.startsWith('enc:') ? decryptSecret(stored.slice(4)) : stored.replace(/^plain:/, ''));
