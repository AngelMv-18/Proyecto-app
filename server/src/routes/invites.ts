import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, rows } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idParam, parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { newToken, sha256 } from '../security.js';
import { isAdmin } from '../services/users.js';

const needAdmin = async (userId: string) => { if (!(await isAdmin(pool, userId))) throw new AppError(403, 'forbidden', 'Solo el administrador puede invitar personas'); };

export async function inviteRoutes(app: FastifyInstance) {
  app.get('/api/invites', async (req) => {
    await needAdmin(uid(req));
    const list = await rows(pool, `SELECT i.id, i.note, i.max_uses, i.uses, i.expires_at, i.revoked, i.created_at,
        (SELECT json_agg(json_build_object('name', u.display_name, 'at', u.created_at) ORDER BY u.created_at) FROM users u WHERE u.invite_id=i.id) AS joined
      FROM invites i ORDER BY i.created_at DESC LIMIT 50`);
    const users = (await rows(pool, 'SELECT count(*)::int n FROM users'))[0].n;
    return { invites: list.map((i) => ({ ...i, active: !i.revoked && i.uses < i.max_uses && new Date(i.expires_at) > new Date() })), users };
  });

  // El enlace solo se muestra al crearlo (en la base se guarda su hash).
  app.post('/api/invites', async (req) => {
    await needAdmin(uid(req));
    const b = parse(z.object({ max_uses: z.number().int().min(1).max(100).default(5), days: z.number().int().min(1).max(30).default(7), note: z.string().trim().max(80).optional() }), req.body);
    const token = newToken(18);
    const r = (await rows(pool, `INSERT INTO invites(token_hash,created_by,note,max_uses,expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id, expires_at`, [sha256(token), uid(req), b.note ?? null, b.max_uses, b.days]))[0];
    await audit(pool, uid(req), 'invite', r.id, 'create', null, { max_uses: b.max_uses, days: b.days });
    return { id: r.id, url: `${config.publicUrl}/#/invitacion/${token}`, expires_at: r.expires_at, max_uses: b.max_uses };
  });

  app.delete('/api/invites/:id', async (req) => {
    await needAdmin(uid(req));
    const { id } = parse(idParam, req.params);
    const r = await pool.query('UPDATE invites SET revoked=true WHERE id=$1', [id]);
    if (!r.rowCount) throw notFound('Invitación');
    await audit(pool, uid(req), 'invite', id, 'revoke');
    return { ok: true };
  });
}
