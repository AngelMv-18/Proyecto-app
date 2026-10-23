import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { Db, one } from '../db.js';
import { AppError } from '../errors.js';
import { sha256 } from '../security.js';
import { seedUser } from '../seed.js';
import { audit } from '../audit.js';

export const NO_PASSWORD = 'none$';

/** Invitación válida (sin consumirla). */
export async function checkInvite(db: Db, token?: string | null) {
  if (!token) return null;
  return one(db, `SELECT i.*, u.display_name AS inviter FROM invites i LEFT JOIN users u ON u.id=i.created_by
     WHERE i.token_hash=$1 AND NOT i.revoked AND i.expires_at > now() AND i.uses < i.max_uses`, [sha256(token)]);
}

/**
 * Reglas para crear cuentas:
 *  - Primera cuenta (instalación vacía): exige REGISTRATION_CODE si está definido.
 *  - Después: con una invitación válida (se consume un uso de forma atómica), o si ALLOW_REGISTRATION=true.
 */
export async function admitNewUser(db: Db, o: { code?: string; invite?: string | null }): Promise<string | null> {
  const n = (await one<{ n: number }>(db, 'SELECT count(*)::int n FROM users'))!.n;
  if (n === 0) {
    if (config.registrationCode) {
      const a = Buffer.from(sha256(o.code ?? '')), e = Buffer.from(sha256(config.registrationCode));
      if (!timingSafeEqual(a, e)) throw new AppError(403, 'bad_registration_code', 'Código de instalación incorrecto');
    }
    return null;
  }
  if (o.invite) {
    const inv = await one(db, `UPDATE invites SET uses = uses + 1 WHERE token_hash=$1 AND NOT revoked AND expires_at > now() AND uses < max_uses RETURNING id`, [sha256(o.invite)]);
    if (!inv) throw new AppError(403, 'invalid_invite', 'La invitación no es válida, venció o ya se usó');
    return inv.id;
  }
  if (config.allowRegistration) return null;
  throw new AppError(403, 'registration_closed', 'Para crear una cuenta necesitas una invitación');
}

export async function createUser(db: Db, u: { email: string; display_name: string; password_hash: string; currency?: string; google_sub?: string | null; invite_id?: string | null }) {
  const exists = await one(db, 'SELECT 1 FROM users WHERE email=$1', [u.email]);
  if (exists) throw new AppError(409, 'email_taken', 'Ya existe una cuenta con ese correo');
  const row = await one(db, `INSERT INTO users(email,display_name,password_hash,currency,google_sub,invite_id,has_password) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.email, u.display_name, u.password_hash, u.currency ?? 'HNL', u.google_sub ?? null, u.invite_id ?? null, u.password_hash !== NO_PASSWORD]);
  await seedUser(db, row.id);
  await audit(db, row.id, 'user', row.id, 'register', null, { via: u.google_sub ? 'google' : 'password', invited: Boolean(u.invite_id) });
  return row;
}

export const isAdmin = async (db: Db, userId: string) => (await one<{ id: string }>(db, 'SELECT id FROM users ORDER BY created_at, id LIMIT 1'))?.id === userId;
