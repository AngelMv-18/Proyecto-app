import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L, closeApp, seededUser } from './helpers.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { authUrl, handleCallback, syncGmail } from '../src/services/gmail.js';
import { runScheduledOnce } from '../src/services/scheduler.js';

afterAll(closeApp);

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const MAILS: Record<string, { subject: string; body: string; date: number }> = {
  m1: { subject: 'Notificación de compra', body: 'Se realizó una compra por L 350.00 en SUPER LA COLONIA. Referencia: QW12345', date: Date.now() - 3600_000 },
  m2: { subject: 'Transacción rechazada', body: 'Su compra por L 900.00 en TIENDA X fue rechazada', date: Date.now() - 1800_000 },
  m3: { subject: 'Promoción', body: 'Aprovecha 20% de descuento en tus compras desde L 99', date: Date.now() - 600_000 },
};
let listIds = ['m1', 'm2', 'm3'];
const calls: string[] = [];
/** Google simulado: token OAuth, renovación y API de Gmail (solo lectura). */
const fakeGoogle: typeof fetch = (async (url: any, init?: any) => {
  const u = String(url); calls.push(u);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(String(init?.body));
    if (p.get('grant_type') === 'authorization_code') return json({ refresh_token: 'rt-1', access_token: 'at', scope: 'https://www.googleapis.com/auth/gmail.readonly openid email', id_token: `x.${b64(JSON.stringify({ email: 'ana@gmail.com' }))}.y` });
    return json({ access_token: 'at-2' });
  }
  if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return json({ messages: listIds.map((id) => ({ id })) });
  const m = u.match(/messages\/(\w+)\?format=full$/);
  if (m) {
    const x = MAILS[m[1]];
    return json({ id: m[1], internalDate: String(x.date), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: x.subject }, { name: 'From', value: 'alertas@banco.hn' }], body: { data: b64(x.body) } } });
  }
  return json({ error: 'no esperado ' + u }, 404);
}) as any;

describe('Gmail con un botón', () => {
  beforeAll(() => {
    (config.google as any).clientId = 'cid'; (config.google as any).clientSecret = 'sec';
    (config as any).encryptionKey = createHash('sha256').update('k').digest();
  });
  afterAll(() => { (config.google as any).clientId = ''; (config.google as any).clientSecret = ''; (config as any).encryptionKey = null; });

  it('vincular asigna sola la cuenta destino, la primera revisión registra solo compras reales y no duplica', async () => {
    const u = await seededUser();
    const url = new URL(await authUrl(pool, u.user.id));
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly openid email');
    expect(url.searchParams.get('access_type')).toBe('offline');
    await handleCallback(pool, 'codigo', url.searchParams.get('state')!, fakeGoogle);
    const st = await u.ok(u.get('/api/integrations'));
    expect(st.gmail).toMatchObject({ configured: true, connected: true, account_email: 'ana@gmail.com' });
    expect(st.gmail.default_account.name).toBe('Banco'); // cuenta bancaria preferida sobre efectivo
    const r1 = await syncGmail(pool, u.user.id, fakeGoogle);
    expect(r1).toMatchObject({ scanned: 3, created: 1, ignored: 2 });
    const tx = await u.ok(u.get('/api/transactions'));
    expect(tx.total).toBe(1);
    expect(tx.items[0]).toMatchObject({ amount: L(350), source: 'email', status: 'pending', merchant: 'SUPER LA COLONIA' });
    // El mismo correo en la siguiente revisión no se duplica
    const r2 = await syncGmail(pool, u.user.id, fakeGoogle);
    expect(r2.created).toBe(0); expect(r2.duplicates).toBe(1);
    // Nunca se usan endpoints de escritura de Gmail
    expect(calls.some((c) => /\/(send|modify|trash|delete)/.test(c))).toBe(false);
  });

  it('si Google falla al vincular, queda registrado el motivo y no se finge la conexión', async () => {
    const u = await seededUser();
    const cases: [any, string][] = [
      [{ error: 'invalid_client' }, 'invalid_client'],
      [{ access_token: 'at', scope: 'openid email' }, 'no_refresh_token'],
      [{ refresh_token: 'rt', access_token: 'at', scope: 'openid email' }, 'scope_missing'],
    ];
    for (const [resp, reason] of cases) {
      const url = new URL(await authUrl(pool, u.user.id));
      const f = (async () => new Response(JSON.stringify(resp), { status: resp.error ? 401 : 200 })) as any;
      await expect(handleCallback(pool, 'c', url.searchParams.get('state')!, f)).rejects.toMatchObject({ code: reason });
    }
    const a = await pool.query(`SELECT after->>'reason' r FROM audit_log WHERE user_id=$1 AND action='connect_failed' ORDER BY created_at`, [u.user.id]);
    expect(a.rows.map((x) => x.r)).toEqual(['invalid_client', 'no_refresh_token', 'scope_missing']);
    expect((await u.ok(u.get('/api/integrations'))).gmail.connected).toBe(false);
  });

  it('el programador revisa Gmail automáticamente cada hora', async () => {
    const u = await seededUser();
    const url = new URL(await authUrl(pool, u.user.id));
    await handleCallback(pool, 'codigo', url.searchParams.get('state')!, fakeGoogle);
    listIds = ['m1'];
    await pool.query(`UPDATE integrations SET last_sync_at = now() - interval '2 hours' WHERE user_id=$1`, [u.user.id]);
    const r = await runScheduledOnce(new Date(), undefined, { fetch: fakeGoogle });
    expect((r as any).gmail).toBeGreaterThanOrEqual(1);
    expect((await u.ok(u.get('/api/transactions'))).total).toBe(1);
    const again = await runScheduledOnce(new Date(), undefined, { fetch: fakeGoogle });
    expect((again as any).gmail).toBe(0); // ya revisado hace menos de una hora
    listIds = ['m1', 'm2', 'm3'];
  });

  it('cambiar la cuenta destino y, sin cuentas, avisar que primero cree una', async () => {
    const u = await seededUser();
    const url = new URL(await authUrl(pool, u.user.id));
    await handleCallback(pool, 'codigo', url.searchParams.get('state')!, fakeGoogle);
    await u.ok(u.patch('/api/integrations/gmail/account', { default_account_id: u.cash.id }));
    expect((await u.ok(u.get('/api/integrations'))).gmail.default_account.name).toBe('Efectivo');
    for (const a of [u.cash, u.bank, u.card]) await u.ok(u.patch(`/api/accounts/${a.id}`, { archived: true }));
    await expect(syncGmail(pool, u.user.id, fakeGoogle)).rejects.toMatchObject({ code: 'no_default_account' });
  });
});
