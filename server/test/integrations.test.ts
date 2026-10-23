import { afterAll, describe, expect, it } from 'vitest';
import { L, balances, closeApp, getApp, seededUser, Client } from './helpers.js';
import { parseFinancialMessage, parseAmount } from '../src/services/parser.js';
import { parseCsv, guessMapping, rowsFromCsv, rowsFromOfx } from '../src/services/importer.js';

afterAll(closeApp);

describe('parser de mensajes financieros', () => {
  it('interpreta importes con formatos hondureños y de EE. UU.', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('1.234,56')).toBe(123456);
    expect(parseAmount('1,234')).toBe(123400);
    expect(parseAmount('120.5')).toBe(12050);
    expect(parseAmount('0')).toBeNull();
  });
  it('reconoce una compra aprobada con comercio, referencia y fecha', () => {
    const p = parseFinancialMessage({ subject: 'Notificación de compra', body: 'Se realizó una compra por L 1,250.50 en SUPER LA COLONIA el 15/03/2026 a las 14:32 con su tarjeta terminada en 4821. Referencia: AB123456. Saldo disponible: L 8,000.00', id: 'm1' });
    expect(p.kind).toBe('movement');
    expect(p).toMatchObject({ type: 'expense', amount: 125050, currency: 'HNL', merchant: 'SUPER LA COLONIA', reference: 'AB123456', card_last4: '4821', bank_state: 'approved' });
    expect(p.occurred_at).toBe('2026-03-15T20:32:00.000Z');
  });
  it('no toma el saldo disponible como importe', () => {
    const p = parseFinancialMessage({ body: 'Compra aprobada en Pizza Hut por L 300.00. Saldo disponible L 5,000.00' });
    expect(p.amount).toBe(30000);
  });
  it('NO registra compras rechazadas, canceladas ni códigos de seguridad', () => {
    expect(parseFinancialMessage({ body: 'Su compra por L 500.00 en Amazon fue rechazada' }).kind).toBe('ignored');
    expect(parseFinancialMessage({ body: 'Transacción cancelada por L 90.00 en Tienda X' }).kind).toBe('ignored');
    expect(parseFinancialMessage({ body: 'Su código de verificación es 123456 para la compra de L 100' }).kind).toBe('ignored');
    expect(parseFinancialMessage({ body: 'Aprovecha 20% de descuento en tus compras, desde L 99' }).kind).toBe('ignored');
  });
  it('marca como pendientes en el banco los movimientos en proceso', () => {
    const p = parseFinancialMessage({ body: 'Compra pendiente de L 75.00 en Cafetería Central, transacción en proceso' });
    expect(p.kind).toBe('movement');
    expect(p.bank_state).toBe('pending');
  });
  it('detecta depósitos como ingresos y dólares', () => {
    expect(parseFinancialMessage({ body: 'Se acreditó un depósito de L 15,000.00 en su cuenta. Ref 998877' })).toMatchObject({ type: 'income', amount: 1500000 });
    expect(parseFinancialMessage({ body: 'Consumo de US$ 12.99 en Netflix' })).toMatchObject({ type: 'expense', currency: 'USD', amount: 1299 });
  });
});

describe('importación de extractos', () => {
  const csv = 'Fecha;Descripción;Débito;Crédito\n01/03/2026;SUPER LA COLONIA;250,00;\n02/03/2026;SALARIO;;15.000,00\n02/03/2026;CAFE;40,00;\n02/03/2026;CAFE;40,00;\nfila mala;x;;\n';
  it('detecta columnas, separador y filas inválidas', () => {
    const t = parseCsv(csv);
    expect(t[0]).toEqual(['Fecha', 'Descripción', 'Débito', 'Crédito']);
    const r = rowsFromCsv(t, guessMapping(t[0]));
    expect(r.rows).toHaveLength(4);
    expect(r.rows[1].amount).toBe(1500000);
    expect(r.rows[0].amount).toBe(-25000);
    expect(r.errors).toHaveLength(1);
  });
  it('OFX: lee FITID, monto y fecha', () => {
    const ofx = '<OFX><CURDEF>HNL<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301120000<TRNAMT>-250.00<FITID>F1<NAME>SUPER</STMTTRN><STMTTRN><DTPOSTED>20260302<TRNAMT>1000.50<FITID>F2<MEMO>Deposito</STMTTRN></OFX>';
    const r = rowsFromOfx(ofx);
    expect(r.rows.map((x) => [x.date, x.amount, x.reference])).toEqual([['2026-03-01', -25000, 'F1'], ['2026-03-02', 100050, 'F2']]);
  });
  it('6. importar dos veces el mismo archivo no genera duplicados; los importados esperan revisión', async () => {
    const u = await seededUser();
    const body = { kind: 'csv', content: csv, account_id: u.bank.id, filename: 'bac-marzo.csv' };
    const first = await u.ok(u.post('/api/import/commit', body));
    expect(first).toMatchObject({ created_rows: 4, duplicate_rows: 0 });
    const second = await u.ok(u.post('/api/import/commit', body));
    expect(second).toMatchObject({ created_rows: 0, duplicate_rows: 4 });
    const list = await u.ok(u.get('/api/transactions?limit=100'));
    expect(list.total).toBe(4); // dos "CAFE" idénticos se conservan, pero solo una vez cada uno
    expect(list.items.every((t: any) => t.status === 'pending' && t.source === 'import')).toBe(true);
    expect((await balances(u)).Banco).toBe(L(10000)); // nada afecta saldos hasta confirmar
    const review = await u.ok(u.get('/api/transactions/review'));
    const ids = review.items.map((t: any) => t.id);
    const conf = await u.ok(u.post('/api/transactions/review/confirm-all', { ids }));
    expect(conf.confirmed).toHaveLength(4);
    expect((await balances(u)).Banco).toBe(L(10000 - 250 + 15000 - 40 - 40));
  });
});

describe('detección y duplicados entre fuentes', () => {
  it('la misma compra por notificación y por correo no se duplica y fusiona la fuente', async () => {
    const u = await seededUser();
    const tok = await u.ok(u.post('/api/integrations/ingest-token', { account_id: u.bank.id }));
    const app = await getApp();
    const ingest = (text: string) => app.inject({ method: 'POST', url: '/api/ingest/notification', headers: { authorization: `Bearer ${tok.token}` }, payload: { text, app: 'BAC' } }).then((r) => r.json());
    const a = await ingest('Compra aprobada por L 450.00 en FARMACIA SIMAN. Ref: ZX9911');
    expect(a.outcome).toBe('created');
    const b = await ingest('Compra aprobada por L 450.00 en FARMACIA SIMAN. Ref: ZX9911'); // misma notificación reenviada
    expect(b.outcome).toBe('duplicate');
    // Otra fuente (correo) sin referencia pero mismo importe/comercio/fecha
    const { createTransaction } = await import('../src/services/ledger.js');
    const { pool } = await import('../src/db.js');
    const userId = u.user.id;
    const mail = await createTransaction(pool, userId, { type: 'expense', amount: L(450), account_id: u.bank.id, merchant: 'Farmacia Siman', source: 'email', status: 'pending', source_label: 'Correo: Aviso de compra' });
    expect(mail.duplicate).toBe(true);
    const list = await u.ok(u.get('/api/transactions'));
    expect(list.total).toBe(1);
    expect(list.items[0].source_label).toContain('Correo');
    expect(list.items[0].status).toBe('pending');
    expect((await balances(u)).Banco).toBe(L(10000)); // sin confirmar no afecta saldo
    await u.ok(u.post(`/api/transactions/${list.items[0].id}/confirm`, { patch: { category_id: u.cat('Salud') } }));
    expect((await balances(u)).Banco).toBe(L(9550));
  });
  it('rechaza el endpoint de ingesta sin token válido y descarta rechazos', async () => {
    const u = await seededUser();
    const app = await getApp();
    expect((await app.inject({ method: 'POST', url: '/api/ingest/notification', payload: { text: 'Compra L 5' } })).statusCode).toBe(401);
    const tok = await u.ok(u.post('/api/integrations/ingest-token', { account_id: u.bank.id }));
    const r = await app.inject({ method: 'POST', url: '/api/ingest/notification', headers: { authorization: `Bearer ${tok.token}` }, payload: { text: 'Compra rechazada por L 900.00 en Tienda' } });
    expect(r.json()).toMatchObject({ outcome: 'ignored' });
    expect((await u.ok(u.get('/api/transactions'))).total).toBe(0);
  });
  it('11. la app informa claramente cuando Gmail no está configurado', async () => {
    const u = await seededUser();
    const st = await u.ok(u.get('/api/integrations'));
    expect(st.gmail.configured).toBe(false);
    expect(st.gmail.connected).toBe(false);
    expect(st.gmail.missing).toEqual(expect.arrayContaining(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_ENCRYPTION_KEY']));
    expect(st.bank_api.status).toBe('no_disponible');
    expect(st.google_pay.status).toBe('no_disponible');
    const c = await u.post('/api/integrations/gmail/connect');
    expect(c.status).toBe(412);
    expect(c.body.error.code).toBe('not_configured');
    const s = await u.post('/api/integrations/gmail/sync');
    expect(s.status).toBe(412);
  });
});
