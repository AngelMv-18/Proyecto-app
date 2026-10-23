import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, seededUser } from './helpers.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { dueDigests, runScheduledOnce } from '../src/services/scheduler.js';
import { dispatchPending } from '../src/services/push.js';

afterAll(closeApp);

describe('resúmenes periódicos', () => {
  it('el resumen del día/semana/mes usa movimientos confirmados y compara con el período anterior', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(300), account_id: u.cash.id, category_id: u.cat('Alimentación'), merchant: 'Súper' }));
    await u.ok(u.post('/api/transactions', { type: 'income', amount: L(1000), account_id: u.bank.id }));
    await u.ok(u.post('/api/transactions', { type: 'transfer', amount: L(200), account_id: u.bank.id, to_account_id: u.cash.id }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(50), account_id: u.cash.id, source: 'notification', merchant: 'Pendiente' }));
    const d = await u.ok(u.get('/api/digests/day'));
    expect(d.summary.expense).toBe(L(300));
    expect(d.summary.income).toBe(L(1000));
    expect(d.top_expenses[0].merchant).toBe('Súper');
    expect(d.pending_review).toBe(1);
    expect(d.quality).toBe('incompleto');
    expect(d.lines.join(' ')).toMatch(/esperan revisión/);
    const m = await u.ok(u.get('/api/digests/month'));
    expect(m.categories[0].name).toBe('Alimentación');
    const last = await u.ok(u.get('/api/digests/month?offset=-1'));
    expect(last.summary.tx_count).toBe(0);
    expect(last.lines).toEqual(['Sin movimientos confirmados en este período.']);
  });

  it('calcula qué resúmenes tocan según la hora local del usuario', () => {
    const tz = 'America/Tegucigalpa'; // UTC-6
    const all = { daily: true, weekly: true, monthly: true };
    expect(dueDigests(tz, new Date('2026-11-01T02:00:00Z'), all)).toEqual([{ period: 'day', offset: 0, key: 'digest:day:2026-10-31' }]); // sábado 20:00 local
    expect(dueDigests(tz, new Date('2026-11-02T01:30:00Z'), all).map((x) => x.period)).toEqual(['week', 'month']); // domingo 1 de noviembre, 19:30
    expect(dueDigests(tz, new Date('2026-11-01T15:00:00Z'), all)).toEqual([{ period: 'month', offset: -1, key: 'digest:month:2026-11' }]); // 1 nov 09:00
    expect(dueDigests(tz, new Date('2026-11-04T15:00:00Z'), all)).toEqual([]);
  });

  it('el programador crea cada resumen una sola vez y respeta las preferencias', async () => {
    const u = await seededUser();
    await u.ok(u.patch('/api/me', { settings: { digests: { daily: true, weekly: false, monthly: false } } }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(10), account_id: u.cash.id }));
    const at = new Date(); at.setUTCHours(3, 0, 0, 0); // 21:00 del día anterior en Honduras
    await runScheduledOnce(at);
    await runScheduledOnce(at);
    const n = (await pool.query(`SELECT * FROM notifications WHERE user_id=$1 AND kind='digest_day'`, [u.user.id])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('Resumen del día');
  });
});

describe('notificaciones push', () => {
  it('sin claves VAPID se informa que no está configurado', async () => {
    const u = await seededUser();
    const s = await u.ok(u.get('/api/push/status'));
    expect(s.configured).toBe(false);
    expect(s.missing).toContain('VAPID_PUBLIC_KEY');
    expect((await u.post('/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'BBBBBBBBBBBBBB', auth: 'AAAAAAAAAA' } })).status).toBe(412);
  });

  it('envía alertas en modo privado (sin importes) y elimina suscripciones caducadas', async () => {
    const u = await seededUser();
    (config.push as any).publicKey = 'test-public'; (config.push as any).privateKey = 'test-private';
    try {
      await u.ok(u.post('/api/push/subscribe', { endpoint: 'https://push.example/a', keys: { p256dh: 'BBBBBBBBBBBBBB', auth: 'AAAAAAAAAA' } }));
      await u.ok(u.post('/api/push/subscribe', { endpoint: 'https://push.example/gone', keys: { p256dh: 'BBBBBBBBBBBBBB', auth: 'AAAAAAAAAA' } }));
      await u.ok(u.put('/api/budgets', { category_id: u.cat('Alimentación'), period: 'monthly', amount: L(100) }));
      await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(150), account_id: u.cash.id, category_id: u.cat('Alimentación') }));
      const sent: { endpoint: string; payload: any }[] = [];
      const sender = async (sub: any, payload: string) => {
        if (sub.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      };
      const me = await u.ok(u.get('/api/me'));
      const n = await dispatchPending(pool, u.user.id, me.settings, sender);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(sent.every((s) => s.endpoint === 'https://push.example/a')).toBe(true);
      const budgetPush = sent.find((s) => s.payload.title.includes('Alimentación'));
      expect(budgetPush!.payload.body).toBe('Abre NOVA para ver los detalles.');
      expect(JSON.stringify(sent)).not.toMatch(/150/);
      expect((await u.ok(u.get('/api/push/status'))).devices).toBe(1); // la caducada se borró
      // No se reenvía lo ya enviado
      expect(await dispatchPending(pool, u.user.id, me.settings, sender)).toBe(0);
    } finally { (config.push as any).publicKey = ''; (config.push as any).privateKey = ''; }
  });
});
