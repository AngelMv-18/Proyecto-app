import { afterAll, describe, expect, it } from 'vitest';
import { L, balances, closeApp, newUser, seededUser } from './helpers.js';
import { pool } from '../src/db.js';

afterAll(closeApp);

describe('tarjeta de débito vinculada a su cuenta', () => {
  it('el mismo dinero se cuenta una sola vez y lo pagado con la tarjeta sale de la cuenta', async () => {
    const u = await newUser();
    const acct = await u.ok(u.post('/api/accounts', { name: 'BAC Ahorro', type: 'bank', bank_code: 'bac', last4: '6480', opening_balance: L(5000), opening_date: '2026-01-01' }));
    const card = await u.ok(u.post('/api/accounts', { name: 'BAC Débito', type: 'debit_card', bank_code: 'bac', last4: '2001', opening_balance: L(5000), opening_date: '2026-01-01' }));
    const before = await u.ok(u.get('/api/dashboard'));
    expect(before.available).toBe(L(10000)); // el problema: se suma dos veces
    // Un gasto que ya tenía la tarjeta pasa a la cuenta al vincular
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: card.id, merchant: 'Pulpería' }));
    await u.ok(u.patch(`/api/accounts/${card.id}`, { linked_account_id: acct.id }));
    const after = await u.ok(u.get('/api/dashboard'));
    expect(after.available).toBe(L(4900));
    const list = await u.ok(u.get('/api/accounts'));
    const c = list.find((x: any) => x.id === card.id);
    expect(c).toMatchObject({ balance: 0, opening_balance: 0, linked_account_id: acct.id, linked_name: 'BAC Ahorro', shared_balance: L(4900) });
    // Pagar con la tarjeta descuenta de la cuenta
    const tx = await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(250), account_id: card.id, merchant: 'Super' }));
    expect(tx.tx).toMatchObject({ account_id: acct.id, payment_method: 'Débito BAC Débito' });
    expect((await balances(u))['BAC Ahorro']).toBe(L(4650));
    expect((await u.ok(u.get('/api/dashboard'))).available).toBe(L(4650));
    // Vista de la tarjeta: muestra los números de la cuenta
    const ov = await u.ok(u.get(`/api/accounts/${card.id}/overview`));
    expect(ov.month_spent).toBe(L(350));
    // No se puede vincular a una tarjeta de crédito ni transferir entre ellas
    const cc = await u.ok(u.post('/api/accounts', { name: 'Crédito', type: 'credit_card', credit_limit: L(1000) }));
    expect((await u.patch(`/api/accounts/${card.id}`, { linked_account_id: cc.id })).status).toBe(400);
    expect((await u.post('/api/transactions', { type: 'transfer', amount: L(10), account_id: card.id, to_account_id: acct.id })).status).toBe(400);
    // Queda registrado en la auditoría
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='link'`, [card.id])).rowCount).toBe(1);
  });
});

describe('NOVA AI en modo local sin movimientos', () => {
  const ask = (u: any, q: string) => u.ok(u.post('/api/ai/chat', { messages: [{ role: 'user', content: q }] })).then((r: any) => r.answer as string);
  it('responde saldos, deudas y pagos aunque no haya movimientos, y explica qué falta para analizar gastos', async () => {
    const u = await seededUser();
    expect(await ask(u, '¿Cuánto dinero tengo?')).toMatch(/disponibles/);
    expect(await ask(u, '¿Cuánto dinero tengo?')).toMatch(/Banco/);
    expect(await ask(u, '¿Cuánto debo?')).toMatch(/No tienes deudas/);
    expect(await ask(u, '¿Qué pagos tengo pronto?')).toMatch(/No tienes pagos programados/);
    expect(await ask(u, '¿En qué gasto más?')).toMatch(/necesito movimientos confirmados/);
    expect(await ask(u, '¿Qué gastos debo reducir?')).toMatch(/necesito movimientos/);
    const unknown = await ask(u, 'cuéntame un chiste de lempiras');
    expect(unknown).toMatch(/No entendí bien/);
    expect(unknown).toMatch(/disponibles/);
  });
});
