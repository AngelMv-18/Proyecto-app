import webpush from 'web-push';
import { config, pushConfigured } from '../config.js';
import { Db, rows } from '../db.js';

export type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;

const realSender: Sender = (sub, payload) => {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  return webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: 'normal' });
};

/** Envía a todos los dispositivos del usuario; borra suscripciones caducadas (404/410). */
export async function sendPush(db: Db, userId: string, msg: { title: string; body: string; url?: string; tag?: string }, sender: Sender = realSender) {
  if (!pushConfigured()) return { sent: 0, failed: 0, configured: false };
  const subs = await rows(db, 'SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]);
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg));
      sent++;
      await db.query('UPDATE push_subscriptions SET last_ok_at=now(), failures=0 WHERE id=$1', [s.id]);
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
      else await db.query('UPDATE push_subscriptions SET failures=failures+1 WHERE id=$1', [s.id]);
    }
  }
  return { sent, failed, configured: true };
}

export const DEFAULT_PUSH_PREFS = { enabled: true, private: true, min_severity: 'warning' as 'info' | 'warning' | 'critical' };
const RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Envía por push las notificaciones recientes aún no enviadas. En modo privado (por defecto) el texto del
 * aviso que aparece en la pantalla de bloqueo no incluye importes ni comercios.
 */
export async function dispatchPending(db: Db, userId: string, settings: any, sender?: Sender) {
  const prefs = { ...DEFAULT_PUSH_PREFS, ...(settings?.push ?? {}) };
  const pend = await rows(db, `SELECT * FROM notifications WHERE user_id=$1 AND pushed_at IS NULL AND read_at IS NULL AND created_at > now() - interval '1 day' ORDER BY created_at LIMIT 10`, [userId]);
  if (!pend.length) return 0;
  // Se marcan primero para no reenviar aunque falle un dispositivo.
  await db.query('UPDATE notifications SET pushed_at=now() WHERE id = ANY($1)', [pend.map((n) => n.id)]);
  if (!prefs.enabled || !pushConfigured()) return 0;
  let n = 0;
  for (const x of pend) {
    const isDigest = String(x.kind).startsWith('digest');
    if (!isDigest && RANK[x.severity as keyof typeof RANK] < RANK[prefs.min_severity as keyof typeof RANK]) continue;
    const r = await sendPush(db, userId, { title: x.title, body: prefs.private ? 'Abre NOVA para ver los detalles.' : x.body, url: isDigest ? '/#/informes?vista=resumenes' : '/#/', tag: x.kind }, sender);
    n += r.sent;
  }
  return n;
}
