import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, newUser, seededUser } from './helpers.js';
import { pool } from '../src/db.js';
import { htmlToText, parseFinancialMessage } from '../src/services/parser.js';
import { ingestParsed } from '../src/services/ingest.js';

afterAll(closeApp);

// Estructura del recibo real de Google Play (datos personales y número de pedido reemplazados).
const GOOGLE_PLAY = `<table><tr><td><img alt="Google Play"></td></tr>
<tr><td><h2>Gracias</h2></td></tr>
<tr><td><p>Compraste contenido de Supercell en Google Play.</p></td></tr>
<tr><td><p><b>Número de pedido:</b> GPA.3317-0854-4171-84791</p><p><b>Fecha del pedido:</b> 24 oct 2026 10:01:48 a.m. GMT-6</p></td></tr></table>
<table><tr><th>Artículo</th><th>Precio</th></tr>
<tr><td>Oferta (Clash Royale)</td><td>USD 1.99</td></tr>
<tr><td></td><td>Impuesto: USD 0.00</td></tr><tr><td></td><td>Total: USD 1.99</td></tr></table>
<table><tr><td>Forma de pago:</td><td>Bac débito Angel</td></tr></table>
<p>¿Tienes alguna pregunta? Visita Supercell.</p>`;
const receipt = (id = 'gp1') => parseFinancialMessage({ subject: 'El recibo de tu pedido de Google Play del 24 oct 2026', body: htmlToText(GOOGLE_PLAY), id });

describe('recibos de Google Play', () => {
  it('se leen el comercio, el artículo, el importe en USD, el pedido, la fecha y la forma de pago', () => {
    const p = receipt();
    expect(p).toMatchObject({ kind: 'movement', type: 'expense', amount: 199, currency: 'USD', merchant: 'Supercell (Google Play)', description: 'Oferta (Clash Royale)', reference: 'GPA.3317-0854-4171-84791', payment_hint: 'Bac débito Angel', bank: 'bac' });
    expect(p.occurred_at).toBe('2026-10-24T16:01:00.000Z');
  });

  async function setup() {
    const u = await newUser();
    const mk = (b: any) => u.ok(u.post('/api/accounts', { opening_date: '2026-01-01', ...b }));
    const def = await mk({ name: 'Efectivo', type: 'cash' });
    const acct = await mk({ name: 'BAC cuenta Angel', type: 'bank', bank_code: 'bac', last4: '6480', opening_balance: L(1000) });
    const card = await mk({ name: 'Bac débito Angel', type: 'debit_card', bank_code: 'bac', last4: '2001', linked_account_id: acct.id });
    return { u, def, acct, card };
  }

  it('un cobro en USD en una cuenta en lempiras se registra convertido y avisa que el importe es estimado', async () => {
    const { u, def, acct } = await setup();
    await u.ok(u.put('/api/fx', { currency: 'USD', rate: 26 }));
    const r = await ingestParsed(pool, u.user.id, receipt(), { account_id: def.id, source: 'email', label: 'Correo: recibo de Google Play' });
    expect(r.outcome).toBe('created');
    const t = await u.ok(u.get(`/api/transactions/${r.tx_id}`));
    // La forma de pago "Bac débito Angel" es la tarjeta vinculada: el gasto sale de la cuenta BAC
    expect(t).toMatchObject({ account_id: acct.id, status: 'pending', needs_review: true, account_pending: false, amount: 5174, currency: 'HNL', merchant: 'Supercell (Google Play)' });
    expect(t.review_hint).toMatch(/USD 1\.99/); expect(t.review_hint).toMatch(/tu tipo de cambio/);
    expect(t.description).toContain('Oferta (Clash Royale)'); expect(t.description).toContain('GPA.3317-0854-4171-84791');
    // Aún no afecta el saldo
    expect((await u.ok(u.get('/api/accounts'))).find((a: any) => a.id === acct.id).balance).toBe(L(1000));
    // El mismo recibo en la siguiente revisión no se duplica
    const again = await ingestParsed(pool, u.user.id, receipt('otro-id'), { account_id: def.id, source: 'email', label: 'Correo' });
    expect(again.outcome).toBe('duplicate');
  });

  it('sin tipo de cambio propio usa uno de referencia y lo dice; al corregir el importe el aviso desaparece', async () => {
    const { u, def } = await setup();
    const r = await ingestParsed(pool, u.user.id, receipt('gp2'), { account_id: def.id, source: 'email', label: 'Correo' });
    const t = await u.ok(u.get(`/api/transactions/${r.tx_id}`));
    expect(t.amount).toBe(5274); expect(t.review_hint).toMatch(/de referencia/);
    await u.ok(u.patch(`/api/transactions/${r.tx_id}`, { amount: 5300 }));
    expect((await u.ok(u.get(`/api/transactions/${r.tx_id}`))).review_hint).toBeNull();
  });
});

describe('cuando no se sabe de qué tarjeta o cuenta es', () => {
  const msg = (id: string) => parseFinancialMessage({ body: 'Compra aprobada en Farmacia Kielsa por L 150.00', id });
  it('queda marcado para elegir cuenta: no se puede confirmar hasta elegirla', async () => {
    const u = await seededUser(); // Efectivo, Banco y Tarjeta: varios lugares posibles
    const r = await ingestParsed(pool, u.user.id, msg('a1'), { account_id: u.cash.id, source: 'email', label: 'Correo', ask_if_unmatched: true });
    expect(r).toMatchObject({ outcome: 'created', ask_account: true });
    const t = await u.ok(u.get(`/api/transactions/${r.tx_id}`));
    expect(t).toMatchObject({ account_id: u.cash.id, account_pending: true, status: 'pending' });
    // Confirmar sin elegir: rechazado (también en "confirmar todos")
    expect((await u.post(`/api/transactions/${r.tx_id}/confirm`, {})).status).toBe(400);
    const all = await u.ok(u.post('/api/transactions/review/confirm-all', { ids: [r.tx_id] }));
    expect(all.confirmed).toEqual([]); expect(all.failed).toHaveLength(1);
    // Al elegir la cuenta se puede confirmar, y el gasto sale de la elegida
    await u.ok(u.patch(`/api/transactions/${r.tx_id}`, { account_id: u.bank.id }));
    expect((await u.ok(u.get(`/api/transactions/${r.tx_id}`))).account_pending).toBe(false);
    await u.ok(u.post(`/api/transactions/${r.tx_id}/confirm`, {}));
    expect((await u.ok(u.get('/api/accounts'))).find((a: any) => a.id === u.bank.id).balance).toBe(L(10000) - L(150));
  });

  it('con una sola cuenta no pregunta nada', async () => {
    const u = await newUser();
    const acc = await u.ok(u.post('/api/accounts', { name: 'Efectivo', type: 'cash', opening_date: '2026-01-01' }));
    const r = await ingestParsed(pool, u.user.id, msg('b1'), { account_id: acc.id, source: 'email', label: 'Correo', ask_if_unmatched: true });
    expect(r.ask_account).toBe(false);
    expect((await u.ok(u.get(`/api/transactions/${r.tx_id}`))).account_pending).toBe(false);
  });

  it('si el aviso trae los últimos 4 dígitos de una tarjeta, va a esa tarjeta sin preguntar', async () => {
    const u = await seededUser();
    const card = await u.ok(u.post('/api/accounts', { name: 'Atlántida', type: 'credit_card', credit_limit: L(5000), last4: '1093', opening_date: '2020-01-01' }));
    const r = await ingestParsed(pool, u.user.id, parseFinancialMessage({ body: 'Compra aprobada en Pizza Hut por L 300.00 con su tarjeta terminada en 1093', id: 'c1' }), { account_id: u.cash.id, source: 'email', label: 'Correo', ask_if_unmatched: true });
    const t = await u.ok(u.get(`/api/transactions/${r.tx_id}`));
    expect(t).toMatchObject({ account_id: card.id, account_pending: false });
  });
});
