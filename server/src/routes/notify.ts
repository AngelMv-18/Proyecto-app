import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, pushConfigured } from '../config.js';
import { one, pool } from '../db.js';
import { AppError } from '../errors.js';
import { parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { rateLimit } from '../security.js';
import { buildDigest } from '../services/digest.js';
import { DEFAULT_PUSH_PREFS, sendPush } from '../services/push.js';
import { DEFAULT_DIGEST_PREFS } from '../services/scheduler.js';

export async function notifyRoutes(app: FastifyInstance) {
  app.get('/api/digests/:period', async (req) => {
    const { period } = parse(z.object({ period: z.enum(['day', 'week', 'month']) }), req.params);
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(-24).max(0).default(0) }), req.query);
    return buildDigest(pool, uid(req), period, offset);
  });

  app.get('/api/push/status', async (req) => {
    const u = await one(pool, 'SELECT settings FROM users WHERE id=$1', [uid(req)]);
    const n = (await one<{ n: number }>(pool, 'SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1', [uid(req)]))!.n;
    return {
      configured: pushConfigured(), public_key: pushConfigured() ? config.push.publicKey : null, devices: n,
      missing: pushConfigured() ? [] : ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
      push: { ...DEFAULT_PUSH_PREFS, ...(u.settings?.push ?? {}) }, digests: { ...DEFAULT_DIGEST_PREFS, ...(u.settings?.digests ?? {}) },
    };
  });

  const sub = z.object({ endpoint: z.string().url().startsWith('https://').max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }) });
  app.post('/api/push/subscribe', async (req) => {
    if (!pushConfigured()) throw new AppError(412, 'not_configured', 'Las notificaciones push no están configuradas en el servidor (faltan claves VAPID)');
    const b = parse(sub, req.body);
    // Si el dispositivo estaba asociado a otra cuenta, pasa a esta (el endpoint identifica al navegador).
    await pool.query(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4, user_agent=$5, failures=0`, [uid(req), b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
    await audit(pool, uid(req), 'push', null, 'subscribe');
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    const b = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [uid(req), b.endpoint]);
    await audit(pool, uid(req), 'push', null, 'unsubscribe');
    return { ok: true };
  });
  app.post('/api/push/test', async (req) => {
    await rateLimit(pool, `pushtest:${uid(req)}`, 5, 300);
    const r = await sendPush(pool, uid(req), { title: 'NOVA FINANCE', body: 'Las notificaciones funcionan en este dispositivo.', url: '/#/perfil', tag: 'test' });
    if (!r.configured) throw new AppError(412, 'not_configured', 'Faltan las claves VAPID en el servidor');
    return r;
  });
}
