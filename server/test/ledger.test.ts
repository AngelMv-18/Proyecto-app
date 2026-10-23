import { afterAll, describe, expect, it } from 'vitest';
import { L, balances, closeApp, seededUser } from './helpers.js';

afterAll(closeApp);

describe('contabilidad básica', () => {
  it('1. registrar un gasto reduce el saldo de la cuenta y actualiza el presupuesto', async () => {
    const u = await seededUser();
    await u.ok(u.put('/api/budgets', { category_id: u.cat('Alimentación'), period: 'monthly', amount: L(1000) }));
    const r = await u.post('/api/transactions', { type: 'expense', amount: L(120), account_id: u.cash.id, category_id: u.cat('Alimentación'), merchant: 'Pulpería' });
    expect(r.status).toBe(201);
    expect((await balances(u)).Efectivo).toBe(L(880));
    const b = await u.ok(u.get('/api/budgets'));
    expect(b[0].spent).toBe(L(120));
    expect(b[0].pct).toBe(12);
  });

  it('2. registrar un ingreso aumenta el saldo', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'income', amount: L(2500), account_id: u.bank.id }));
    expect((await balances(u)).Banco).toBe(L(12500));
  });

  it('3. una transferencia entre cuentas propias no cambia el patrimonio ni cuenta como ingreso/gasto', async () => {
    const u = await seededUser();
    const before = await u.ok(u.get('/api/dashboard'));
    await u.ok(u.post('/api/transactions', { type: 'transfer', amount: L(500), account_id: u.bank.id, to_account_id: u.cash.id }));
    const b = await balances(u);
    expect(b.Banco).toBe(L(9500));
    expect(b.Efectivo).toBe(L(1500));
    const after = await u.ok(u.get('/api/dashboard'));
    expect(after.net_worth).toBe(before.net_worth);
    expect(after.month.income).toBe(0);
    expect(after.month.expense).toBe(0);
  });

  it('4. pagar la tarjeta cancela la deuda sin duplicar el gasto', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(3000), account_id: u.card.id, category_id: u.cat('Tecnología') }));
    let accs = await u.ok(u.get('/api/accounts'));
    let card = accs.find((a: any) => a.name === 'Tarjeta');
    expect(card.owed).toBe(L(3000));
    expect(card.available_credit).toBe(L(17000));
    await u.ok(u.post('/api/transactions', { type: 'transfer', amount: L(3000), account_id: u.bank.id, to_account_id: u.card.id }));
    accs = await u.ok(u.get('/api/accounts'));
    card = accs.find((a: any) => a.name === 'Tarjeta');
    expect(card.owed).toBe(0);
    const d = await u.ok(u.get('/api/dashboard'));
    expect(d.month.expense).toBe(L(3000)); // solo la compra original
  });

  it('5. una devolución corrige el gasto de forma consistente y no excede el original', async () => {
    const u = await seededUser();
    const e = await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(800), account_id: u.cash.id, category_id: u.cat('Compras personales') }));
    await u.ok(u.post('/api/transactions', { type: 'refund', amount: L(300), account_id: u.cash.id, refund_of: e.tx.id }));
    expect((await balances(u)).Efectivo).toBe(L(500));
    const d = await u.ok(u.get('/api/dashboard'));
    expect(d.month.expense).toBe(L(500));
    expect(d.categories.find((c: any) => c.name === 'Compras personales').total).toBe(L(500));
    const bad = await u.post('/api/transactions', { type: 'refund', amount: L(600), account_id: u.cash.id, refund_of: e.tx.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('refund_exceeds');
  });

  it('7. editar y anular un movimiento actualiza saldos e indicadores y conserva el historial', async () => {
    const u = await seededUser();
    const e = (await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: u.cash.id }))).tx;
    await u.ok(u.patch(`/api/transactions/${e.id}`, { amount: L(250) }));
    expect((await balances(u)).Efectivo).toBe(L(750));
    expect((await u.ok(u.get('/api/dashboard'))).month.expense).toBe(L(250));
    expect((await u.post(`/api/transactions/${e.id}/void`, { reason: 'x' })).status).toBe(400); // motivo demasiado corto
    await u.ok(u.post(`/api/transactions/${e.id}/void`, { reason: 'Registrado por error' }));
    expect((await balances(u)).Efectivo).toBe(L(1000));
    expect((await u.ok(u.get('/api/dashboard'))).month.expense).toBe(0);
    const det = await u.ok(u.get(`/api/transactions/${e.id}`));
    expect(det.status).toBe('void');
    expect(det.history.map((h: any) => h.action)).toEqual(['create', 'update', 'void']);
    // Los confirmados no se eliminan silenciosamente
    const e2 = (await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(10), account_id: u.cash.id }))).tx;
    expect((await u.del(`/api/transactions/${e2.id}`)).status).toBe(409);
    expect((await u.post(`/api/transactions/${e.id}/void`, { reason: 'otra vez' })).status).toBe(409);
  });

  it('8. los presupuestos solo cuentan gastos de su período', async () => {
    const u = await seededUser();
    await u.ok(u.put('/api/budgets', { category_id: u.cat('Transporte'), period: 'monthly', amount: L(500) }));
    const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1); lastMonth.setUTCDate(15);
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(400), account_id: u.cash.id, category_id: u.cat('Transporte'), occurred_at: lastMonth.toISOString() }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: u.cash.id, category_id: u.cat('Transporte') }));
    const b = (await u.ok(u.get('/api/budgets')))[0];
    expect(b.spent).toBe(L(100));
    expect(b.level).toBe(0);
    // Transferir presupuesto entre categorías
    await u.ok(u.put('/api/budgets', { category_id: u.cat('Hogar'), period: 'monthly', amount: L(300) }));
    const all = await u.ok(u.get('/api/budgets'));
    const hogar = all.find((x: any) => x.category_name === 'Hogar');
    await u.ok(u.post('/api/budgets/transfer', { from_id: hogar.id, to_id: b.id, amount: L(100) }));
    const after = await u.ok(u.get('/api/budgets'));
    expect(after.find((x: any) => x.category_name === 'Hogar').amount).toBe(L(200));
    expect(after.find((x: any) => x.category_name === 'Transporte').amount).toBe(L(600));
  });

  it('9. las metas no crean dinero ficticio', async () => {
    const u = await seededUser();
    const g = await u.ok(u.post('/api/goals', { name: 'Teléfono', target_amount: L(5000), priority: 1 }));
    const before = await u.ok(u.get('/api/dashboard'));
    await u.ok(u.post(`/api/goals/${g.id}/contribute`, { account_id: u.cash.id, amount: L(400) }));
    expect((await balances(u)).Efectivo).toBe(L(1000)); // reserva virtual: el saldo real no cambia
    const mid = await u.ok(u.get('/api/dashboard'));
    expect(mid.month.income).toBe(0);
    expect(mid.net_worth).toBe(before.net_worth);
    expect(mid.reserved).toBe(L(400));
    expect(mid.free_to_spend).toBe(before.free_to_spend - L(400));
    // No se puede reservar más de lo que hay en la cuenta
    const over = await u.post(`/api/goals/${g.id}/contribute`, { account_id: u.cash.id, amount: L(700) });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('insufficient_funds');
    // Meta con cuenta real: mueve el dinero entre cuentas, sin cambiar el patrimonio
    const sav = await u.ok(u.post('/api/accounts', { name: 'Ahorro viaje', type: 'savings', opening_date: '2020-01-01' }));
    const g2 = await u.ok(u.post('/api/goals', { name: 'Viaje', target_amount: L(3000), account_id: sav.id }));
    await u.ok(u.post(`/api/goals/${g2.id}/contribute`, { account_id: u.bank.id, amount: L(1500) }));
    const b = await balances(u);
    expect(b.Banco).toBe(L(8500)); expect(b['Ahorro viaje']).toBe(L(1500));
    expect((await u.ok(u.get('/api/dashboard'))).net_worth).toBe(before.net_worth);
    const goals = await u.ok(u.get('/api/goals'));
    expect(goals.find((x: any) => x.name === 'Viaje').saved).toBe(L(1500));
    // No se puede retirar más de lo ahorrado
    expect((await u.post(`/api/goals/${g2.id}/contribute`, { account_id: u.bank.id, amount: -L(2000) })).status).toBe(400);
  });

  it('12. los saldos coinciden con los saldos iniciales más los movimientos confirmados (propiedad)', async () => {
    const u = await seededUser();
    const accs = [u.cash.id, u.bank.id, u.card.id];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const expected: Record<string, number> = { [u.cash.id]: L(1000), [u.bank.id]: L(10000), [u.card.id]: 0 };
    const ids: any[] = [];
    for (let i = 0; i < 60; i++) {
      const a = accs[Math.floor(rnd() * 3)], amt = Math.ceil(rnd() * 50000) + 1;
      const k = rnd();
      if (k < 0.4) { const r = await u.ok(u.post('/api/transactions', { type: 'expense', amount: amt, account_id: a })); expected[a] -= amt; ids.push([r.tx.id, a, -amt]); }
      else if (k < 0.7) { const r = await u.ok(u.post('/api/transactions', { type: 'income', amount: amt, account_id: a })); expected[a] += amt; ids.push([r.tx.id, a, amt]); }
      else { const b = accs[(accs.indexOf(a) + 1) % 3]; await u.ok(u.post('/api/transactions', { type: 'transfer', amount: amt, account_id: a, to_account_id: b })); expected[a] -= amt; expected[b] += amt; }
      if (rnd() < 0.15 && ids.length) { const [id, acc, eff] = ids.splice(Math.floor(rnd() * ids.length), 1)[0]; await u.ok(u.post(`/api/transactions/${id}/void`, { reason: 'prueba de anulación' })); expected[acc] -= eff; }
    }
    const got = Object.fromEntries((await u.ok(u.get('/api/accounts'))).map((a: any) => [a.id, a.balance]));
    expect(got).toEqual(expected);
    const total = Object.values(expected).reduce((s, x) => s + x, 0);
    expect((await u.ok(u.get('/api/dashboard'))).net_worth).toBe(total);
  });
});

describe('deudas y validaciones', () => {
  it('deudas: el registro de la deuda y sus movimientos no se cuentan dos veces', async () => {
    const u = await seededUser();
    const d = await u.ok(u.post('/api/debts', { direction: 'owe', counterparty: 'Carlos', original_amount: L(2000), cash_account_id: u.cash.id }));
    // El préstamo recibido aumenta efectivo pero no es ingreso real
    expect((await balances(u)).Efectivo).toBe(L(3000));
    let dash = await u.ok(u.get('/api/dashboard'));
    expect(dash.month.income).toBe(0);
    expect(dash.payable).toBe(L(2000));
    await u.ok(u.post(`/api/debts/${d.id}/payments`, { account_id: u.cash.id, amount: L(500) }));
    dash = await u.ok(u.get('/api/dashboard'));
    expect(dash.payable).toBe(L(1500));
    expect(dash.month.expense).toBe(0); // pagar deuda no es gasto de consumo
    expect((await balances(u)).Efectivo).toBe(L(2500));
    const over = await u.post(`/api/debts/${d.id}/payments`, { account_id: u.cash.id, amount: L(5000) });
    expect(over.body.error.code).toBe('debt_overpay');
    await u.ok(u.post(`/api/debts/${d.id}/payments`, { account_id: u.cash.id, amount: L(1500) }));
    expect((await u.ok(u.get('/api/debts')))[0].status).toBe('closed');
  });

  it('valida importes, fechas anteriores al saldo inicial y cuentas ajenas', async () => {
    const u = await seededUser();
    expect((await u.post('/api/transactions', { type: 'expense', amount: 0, account_id: u.cash.id })).status).toBe(400);
    expect((await u.post('/api/transactions', { type: 'expense', amount: -5, account_id: u.cash.id })).status).toBe(400);
    expect((await u.post('/api/transactions', { type: 'expense', amount: 5.5, account_id: u.cash.id })).status).toBe(400);
    const early = await u.post('/api/transactions', { type: 'expense', amount: 100, account_id: u.cash.id, occurred_at: '2019-01-01T00:00:00Z' });
    expect(early.body.error.code).toBe('before_opening');
    expect((await u.post('/api/transactions', { type: 'transfer', amount: 100, account_id: u.cash.id, to_account_id: u.cash.id })).status).toBe(400);
  });

  it('conciliación: calcula diferencia y puede generar un ajuste', async () => {
    const u = await seededUser();
    const today = new Date().toISOString().slice(0, 10);
    const r = await u.ok(u.post(`/api/accounts/${u.bank.id}/reconcile`, { bank_balance: L(9900), as_of: today, create_adjustment: true }));
    expect(r.difference).toBe(-L(100));
    expect((await balances(u)).Banco).toBe(L(9900));
    const accs = await u.ok(u.get('/api/accounts'));
    expect(accs.find((a: any) => a.name === 'Banco').bank_confirmed_balance).toBe(L(9900));
    expect((await u.ok(u.get('/api/dashboard'))).month.expense).toBe(0); // un ajuste no es gasto
  });
});

describe('apariencia de tarjeta y detalle por cuenta', () => {
  it('guarda banco, red y últimos 4; rechaza números completos', async () => {
    const u = await seededUser();
    const a = await u.ok(u.post('/api/accounts', { name: 'BAC Débito', type: 'debit_card', bank_code: 'bac', card_network: 'visa', last4: '1824', opening_date: '2020-01-01' }));
    expect(a).toMatchObject({ bank_code: 'bac', card_network: 'visa', last4: '1824' });
    expect((await u.post('/api/accounts', { name: 'X', type: 'debit_card', last4: '4111111111111111' })).status).toBe(400);
    expect((await u.post('/api/accounts', { name: 'Y', type: 'debit_card', card_colors: 'red' })).status).toBe(400);
    const p = await u.ok(u.patch(`/api/accounts/${a.id}`, { card_colors: '#112233,#445566', last4: null }));
    expect(p).toMatchObject({ bank_code: 'bac', card_colors: '#112233,#445566', last4: null });
  });

  it('el detalle muestra fondos, pagos agendados con esa tarjeta y lo que queda después', async () => {
    const u = await seededUser();
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await u.ok(u.post('/api/recurring', { name: 'Netflix', amount: L(250), frequency: 'monthly', next_date: soon, account_id: u.card.id }));
    await u.ok(u.post('/api/recurring', { name: 'Alquiler', amount: L(5000), frequency: 'monthly', next_date: soon, account_id: u.bank.id }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(1000), account_id: u.card.id }));
    const card = await u.ok(u.get(`/api/accounts/${u.card.id}/overview`));
    expect(card.upcoming.map((o: any) => o.name)).toEqual(['Netflix']);
    expect(card.upcoming_total).toBe(L(250));
    expect(card.account.available_credit).toBe(L(19000));
    expect(card.after_upcoming).toBe(L(19000) - L(250));
    expect(card.month_spent).toBe(L(1000));
    expect(card.recent).toHaveLength(1);
    const bank = await u.ok(u.get(`/api/accounts/${u.bank.id}/overview`));
    expect(bank.after_upcoming).toBe(L(10000) - L(5000));
    const other = await seededUser();
    expect((await other.get(`/api/accounts/${u.card.id}/overview`)).status).toBe(404);
  });
});
