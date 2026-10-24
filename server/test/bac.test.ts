import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, seededUser } from './helpers.js';
import { pool } from '../src/db.js';
import { htmlToText, parseFinancialMessage } from '../src/services/parser.js';
import { ingestParsed } from '../src/services/ingest.js';

afterAll(closeApp);

// Estructura de los avisos reales de BAC Credomatic Honduras (datos personales reemplazados).
const BAC_CUENTA = `<table><tr><td><img alt="BAC"></td></tr>
<tr><td><h2>Hola CLIENTE DE PRUEBA ,</h2></td><td><img alt=""></td></tr>
<tr><td>Se ha realizado una transacción por</td><td><b>LPS 2,000.00</b></td></tr></table>
<table><tr><td><p>Estimado(a) CLIENTE DE PRUEBA</p><p>BAC Credomatic le informa que se ha realizado una transacción en su cuenta en LPS, número *****6480, por un monto de 2,000.00 LPS.</p></td></tr></table>
<table><tr><td>Fecha</td><td>18/10/2026 a las 16:38:37</td></tr><tr><td>Monto enviado</td><td><b>2,000.00 LPS.</b></td></tr></table>
<p>Por favor <b>verifique su transacción</b> en el histórico transaccional de nuestra Banca en Línea.</p>`;

const BAC_TARJETA = `<h1>BAC Credomatic Informa:</h1><h1>MASTERCARD 2001</h1>
<p>Estimado cliente, notificamos que se ha realizado la siguiente transacción con su tarjeta. A continuación el detalle de la misma.</p>
<h3>Detalles del movimiento:</h3>
<table><tr><th><img alt=""><br>Comercio</th><th><img alt=""><br>Monto</th></tr>
<tr><td>PedidosYa*Little Caesa</td><td>L 372</td></tr></table>
<table><tr><th><img alt=""><br>Horario</th></tr><tr><td>2026/10/15-19:43:47</td></tr></table>`;

describe('Avisos de BAC Credomatic', () => {
  it('tarjeta: comercio, monto, fecha y tarjeta salen de la tabla del correo', () => {
    const p = parseFinancialMessage({ subject: 'Notificación de transacción', body: htmlToText(BAC_TARJETA), id: 'g1' });
    expect(p).toMatchObject({ kind: 'movement', type: 'expense', amount: L(372), currency: 'HNL', merchant: 'PedidosYa*Little Caesa', card_last4: '2001', bank: 'bac' });
    expect(p.occurred_at).toBe(new Date('2026-10-15T19:43:00-06:00').toISOString());
  });

  it('cuenta: envío de 2,000 LPS desde la cuenta ****6480, sin inventar comercio', () => {
    const p = parseFinancialMessage({ subject: 'Notificación de transacción', body: htmlToText(BAC_CUENTA), id: 'g2' });
    expect(p).toMatchObject({ kind: 'movement', type: 'expense', amount: L(2000), currency: 'HNL', merchant: null, card_last4: '6480', bank: 'bac' });
    expect(p.description).toBe('Envío / transferencia · cuenta ****6480');
    expect(p.occurred_at).toBe(new Date('2026-10-18T16:38:00-06:00').toISOString());
  });

  it('cada aviso va a la tarjeta o cuenta con esos últimos 4 dígitos, y queda pendiente de revisión', async () => {
    const u = await seededUser();
    const mk = (b: any) => u.ok(u.post('/api/accounts', b));
    const def = await mk({ name: 'Caja chica', type: 'cash', opening_date: '2026-01-01' });
    const card = await mk({ name: 'BAC Mastercard', type: 'credit_card', credit_limit: L(20000), bank_code: 'bac', last4: '2001', opening_date: '2026-01-01' });
    const acct = await mk({ name: 'BAC Ahorro', type: 'bank', bank_code: 'bac', last4: '6480', opening_balance: L(10000), opening_date: '2026-01-01' });
    const r1 = await ingestParsed(pool, u.user.id, parseFinancialMessage({ body: htmlToText(BAC_TARJETA), id: 'g1' }), { account_id: def.id, source: 'email', label: 'Correo' });
    const r2 = await ingestParsed(pool, u.user.id, parseFinancialMessage({ body: htmlToText(BAC_CUENTA), id: 'g2' }), { account_id: def.id, source: 'email', label: 'Correo' });
    expect([r1, r2].map((r) => r.reason ?? r.outcome)).toEqual(['created', 'created']);
    const t1 = await u.ok(u.get(`/api/transactions/${r1.tx_id}`)); const t2 = await u.ok(u.get(`/api/transactions/${r2.tx_id}`));
    expect(t1).toMatchObject({ account_id: card.id, status: 'pending', merchant: 'PedidosYa*Little Caesa' });
    expect(t2).toMatchObject({ account_id: acct.id, status: 'pending', description: 'Envío / transferencia · cuenta ****6480' });
    // Sin coincidencia de dígitos ni banco, se usa la cuenta destino elegida.
    const r3 = await ingestParsed(pool, u.user.id, parseFinancialMessage({ body: 'Compra aprobada en Farmacia Kielsa por L 150.00', id: 'g3' }), { account_id: def.id, source: 'email', label: 'Correo' });
    expect((await u.ok(u.get(`/api/transactions/${r3.tx_id}`))).account_id).toBe(def.id);
  });

  it('el pie de página "nunca le solicitaremos su clave o PIN" no hace que se descarte la compra; un código real sí', () => {
    const pie = '<p>BAC Credomatic nunca le solicitará su clave, PIN o código de seguridad por correo. No comparta su contraseña.</p>';
    expect(parseFinancialMessage({ body: htmlToText(BAC_TARJETA + pie) })).toMatchObject({ kind: 'movement', amount: L(372) });
    expect(parseFinancialMessage({ body: 'Tu código de verificación es 482913. Compra por L 500.00' }).kind).toBe('ignored');
    expect(parseFinancialMessage({ body: 'Su clave temporal: 7731. Transferencia por L 900.00' }).kind).toBe('ignored');
  });

  it('una notificación rechazada de BAC no se registra', () => {
    const p = parseFinancialMessage({ body: htmlToText(BAC_TARJETA.replace('se ha realizado la siguiente transacción', 'la siguiente transacción fue rechazada')) });
    expect(p.kind).toBe('ignored');
  });
});
