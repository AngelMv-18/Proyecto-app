import { config } from '../config.js';
import { pool, rows } from '../db.js';
import { refreshAlerts } from './alerts.js';
import { buildDigest, Period } from './digest.js';
import { dispatchPending, Sender } from './push.js';
import { syncGmail } from './gmail.js';
import { googleConfigured } from '../config.js';

export const DEFAULT_DIGEST_PREFS = { daily: false, weekly: true, monthly: true };

function localParts(tz: string, now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday as string, day: Number(p.day) };
}

/** Qué resúmenes tocan ahora (hora local del usuario). El mensual resume el mes ya cerrado. */
export function dueDigests(tz: string, now: Date, prefs = DEFAULT_DIGEST_PREFS): { period: Period; offset: number; key: string }[] {
  const l = localParts(tz, now);
  const out: { period: Period; offset: number; key: string }[] = [];
  if (prefs.daily && l.hour >= 20) out.push({ period: 'day', offset: 0, key: `digest:day:${l.date}` });
  if (prefs.weekly && l.weekday === 'Sun' && l.hour >= 19) out.push({ period: 'week', offset: 0, key: `digest:week:${l.date}` });
  if (prefs.monthly && l.day === 1 && l.hour >= 8) out.push({ period: 'month', offset: -1, key: `digest:month:${l.date.slice(0, 7)}` });
  return out;
}

/** Una pasada del programador. Usa un candado de PostgreSQL para que solo una réplica lo ejecute. */
export async function runScheduledOnce(now = new Date(), sender?: Sender, opts: { fetch?: typeof fetch; skipGmail?: boolean } = {}) {
  const c = await pool.connect();
  try {
    const lock = (await c.query('SELECT pg_try_advisory_lock(727001) AS ok')).rows[0].ok;
    if (!lock) return { skipped: true };
    try {
      const users = await rows(c, 'SELECT id, timezone, settings FROM users');
      let digests = 0, pushed = 0;
      for (const u of users) {
        try {
          await refreshAlerts(c, u.id);
          for (const d of dueDigests(u.timezone, now, { ...DEFAULT_DIGEST_PREFS, ...(u.settings?.digests ?? {}) })) {
            const g = await buildDigest(c, u.id, d.period, d.offset);
            const r = await c.query(`INSERT INTO notifications(user_id,kind,severity,title,body,dedupe_key,data) VALUES ($1,$2,'info',$3,$4,$5,$6) ON CONFLICT (user_id,dedupe_key) DO NOTHING`,
              [u.id, `digest_${d.period}`, g.title, g.lines.join(' '), d.key, JSON.stringify({ period: d.period, offset: d.offset })]);
            digests += r.rowCount ?? 0;
          }
          pushed += await dispatchPending(c, u.id, u.settings, sender);
        } catch { /* un usuario con error no detiene al resto */ }
      }
      // Gmail conectado: revisión automática cada hora (sin que la persona tenga que pulsar nada).
      let gmail = 0;
      if (googleConfigured() && !opts.skipGmail) {
        const due = await rows(c, `SELECT user_id FROM integrations WHERE provider='gmail' AND status='connected' AND (last_sync_at IS NULL OR last_sync_at < now() - interval '55 minutes')`);
        for (const g of due) { try { await syncGmail(c, g.user_id, opts.fetch); await refreshAlerts(c, g.user_id); gmail++; } catch { /* el error queda en la integración */ } }
      }
      return { skipped: false, users: users.length, digests, pushed, gmail };
    } finally {
      await c.query('SELECT pg_advisory_unlock(727001)');
    }
  } finally { c.release(); }
}

export function startScheduler() {
  if (!config.scheduler || config.isTest) return;
  const tick = () => runScheduledOnce().catch(() => {});
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 10 * 60_000).unref();
}
