import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, rows } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idParam, parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { rateBlocked, rateHit } from '../security.js';
import { isAdmin } from '../services/users.js';
import { sendPush } from '../services/push.js';

const KIND_LABEL: Record<string, string> = { problem: 'Problema', idea: 'Idea', other: 'Comentario' };

// Comentarios de la etapa de prueba: cada persona ve los suyos; el administrador los ve todos y puede responder.
export async function feedbackRoutes(app: FastifyInstance) {
  app.post('/api/feedback', async (req) => {
    const key = `feedback:${uid(req)}`;
    if ((await rateBlocked(pool, key, 20, 3600)).blocked) throw new AppError(429, 'too_many_attempts', 'Enviaste muchos comentarios seguidos. Intenta de nuevo en un rato.');
    const b = parse(z.object({
      kind: z.enum(['problem', 'idea', 'other']), message: z.string().trim().min(3, 'Cuéntanos un poco más').max(2000),
      rating: z.number().int().min(1).max(5).nullish(), screen: z.string().max(80).nullish(), device: z.string().max(200).nullish(),
    }), req.body);
    await rateHit(pool, key, 3600);
    const f = await one(pool, `INSERT INTO feedback(user_id,kind,message,rating,screen,device) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [uid(req), b.kind, b.message, b.rating ?? null, b.screen ?? null, b.device ?? null]);
    // Aviso dentro de la app para el administrador (si no es él mismo quien escribe).
    const admin = await one<{ id: string }>(pool, 'SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (admin && admin.id !== uid(req)) {
      const u = await one<{ display_name: string }>(pool, 'SELECT display_name FROM users WHERE id=$1', [uid(req)]);
      await pool.query(`INSERT INTO notifications(user_id,kind,severity,title,body,dedupe_key,data) VALUES ($1,'feedback','info',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [admin.id, `${KIND_LABEL[b.kind]} de ${u?.display_name ?? 'un usuario'}`, b.message.slice(0, 160), `feedback:${f.id}`, JSON.stringify({ route: '/comentarios' })]);
      sendPush(pool, admin.id, { title: `Nuevo comentario: ${KIND_LABEL[b.kind].toLowerCase()}`, body: `${u?.display_name ?? 'Alguien'} te dejó un comentario. Toca para verlo.`, url: '/#/comentarios', tag: 'feedback' }).catch(() => {});
    }
    await audit(pool, uid(req), 'feedback', f.id, 'create', null, { kind: b.kind, rating: b.rating ?? null });
    return { id: f.id, created_at: f.created_at };
  });

  app.get('/api/feedback', async (req) => {
    const admin = await isAdmin(pool, uid(req));
    const list = admin
      ? await rows(pool, `SELECT f.*, u.display_name AS author, (f.user_id = $1) AS mine FROM feedback f JOIN users u ON u.id=f.user_id ORDER BY (f.status='new') DESC, f.created_at DESC LIMIT 200`, [uid(req)])
      : await rows(pool, `SELECT f.*, true AS mine FROM feedback f WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 100`, [uid(req)]);
    const counts = admin ? (await rows(pool, `SELECT status, count(*)::int n FROM feedback GROUP BY status`)).reduce((o: any, r: any) => ({ ...o, [r.status]: r.n }), {}) : undefined;
    return { is_admin: admin, items: list, counts };
  });

  app.patch('/api/feedback/:id', async (req) => {
    if (!(await isAdmin(pool, uid(req)))) throw new AppError(403, 'forbidden', 'Solo el administrador puede gestionar los comentarios');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['new', 'seen', 'done']).optional(), reply: z.string().trim().max(1000).nullish() }), req.body);
    const f = await one(pool, `UPDATE feedback SET status=COALESCE($2,status), reply=CASE WHEN $4 THEN $3 ELSE reply END, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.status ?? null, b.reply ?? null, b.reply !== undefined]);
    if (!f) throw notFound('Comentario');
    // Si el administrador responde, la persona lo ve como aviso.
    if (b.reply && f.user_id !== uid(req)) {
      await pool.query(`INSERT INTO notifications(user_id,kind,severity,title,body,dedupe_key,data) VALUES ($1,'feedback_reply','info','Respondieron tu comentario',$2,$3,$4)
        ON CONFLICT (user_id,dedupe_key) DO UPDATE SET body=EXCLUDED.body, read_at=NULL, created_at=now()`, [f.user_id, b.reply.slice(0, 160), `feedback_reply:${f.id}`, JSON.stringify({ route: '/comentarios' })]);
    }
    await audit(pool, uid(req), 'feedback', id, 'update', null, { status: b.status, replied: Boolean(b.reply) });
    return f;
  });
}
