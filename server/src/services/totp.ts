import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238): HMAC-SHA1, 6 dígitos, pasos de 30 s. Compatible con Google Authenticator, Authy, Aegis, etc.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('base32 inválido');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

/** Verifica con tolerancia de ±1 paso. Devuelve el paso usado (para impedir reutilización) o null. */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const exp = totpAt(secret, step);
    if (timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent('NOVA FINANCE')}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent('NOVA FINANCE')}&algorithm=SHA1&digits=6&period=30`;

export const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => {
  const r = randomBytes(5).toString('hex').toUpperCase();
  return `${r.slice(0, 5)}-${r.slice(5)}`;
});
