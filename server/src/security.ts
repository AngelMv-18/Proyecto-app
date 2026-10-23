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

// Limitador en memoria para intentos de acceso (por clave: ip+email).
const attempts = new Map<string, { n: number; first: number }>();
const WINDOW = 15 * 60_000;
const MAX = 8;
export function loginThrottle(key: string): { blocked: boolean; retryInSec: number } {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > WINDOW) return { blocked: false, retryInSec: 0 };
  return a.n >= MAX ? { blocked: true, retryInSec: Math.ceil((a.first + WINDOW - now) / 1000) } : { blocked: false, retryInSec: 0 };
}
export function loginFailed(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > WINDOW) attempts.set(key, { n: 1, first: now });
  else a.n++;
}
export function loginOk(key: string) { attempts.delete(key); }
export function resetThrottle() { attempts.clear(); }
