// Carga datos de DEMOSTRACIÓN en una instalación local (opcional, solo para probar la interfaz).
// Uso: node scripts/demo.mjs [http://localhost:3000]
const base = process.argv[2] ?? 'http://localhost:3000';
let cookie = '';
const call = async (m, u, b) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'nova', cookie }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${u}: ${JSON.stringify(j)}`); return j;
};
const L = (x) => Math.round(x * 100);
const day = (n, h = 12) => { const d = new Date(Date.now() - n * 86400000); d.setHours(h, 0, 0, 0); return d.toISOString(); };

await call('POST', '/api/auth/register', { email: 'demo@nova.local', password: 'demo-nova-2026', display_name: 'Demo' });
const open = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
const cash = await call('POST', '/api/accounts', { name: 'Efectivo', type: 'cash', opening_balance: L(800), opening_date: open });
const bank = await call('POST', '/api/accounts', { name: 'Cuenta BAC', type: 'bank', opening_balance: L(6500), opening_date: open });
const card = await call('POST', '/api/accounts', { name: 'Tarjeta Ficohsa', type: 'credit_card', credit_limit: L(25000), opening_date: open });
const wallet = await call('POST', '/api/accounts', { name: 'Billetera Tigo Money', type: 'wallet', opening_balance: L(300), opening_date: open });
const cats = await call('GET', '/api/categories'); const cat = (n) => cats.find((c) => c.name === n && !c.parent_id).id;
for (const m of [3, 2, 1, 0]) { const d = m * 30 + 3; if (d < 100) await call('POST', '/api/transactions', { type: 'income', amount: L(22000), account_id: bank.id, occurred_at: day(d), merchant: 'Empresa S.A.', category_id: cats.find((c) => c.name === 'Salario').id, payment_method: 'Transferencia' }); }
const spend = [['Alimentación', 'Supermercado La Colonia', 650, cash], ['Alimentación', 'Pollo Campero', 210, cash], ['Transporte', 'Gasolinera Uno', 900, card], ['Servicios', 'ENEE', 1150, bank], ['Servicios', 'Claro Internet', 780, bank], ['Entretenimiento', 'Cinemark', 320, card], ['Salud', 'Farmacia Siman', 420, wallet], ['Compras personales', 'Zara', 1300, card], ['Hogar', 'Alquiler', 5500, bank], ['Alimentación', 'Pizza Hut', 380, card]];
for (let i = 0; i < 80; i += 1) { const s = spend[i % spend.length]; await call('POST', '/api/transactions', { type: 'expense', amount: L(s[2] * (0.85 + ((i * 7) % 30) / 100)), account_id: s[3].id, category_id: cat(s[0]), merchant: s[1], occurred_at: day(1 + ((i * 5) % 95), 9 + (i % 10)), payment_method: s[3].type === 'cash' ? 'Efectivo' : s[3].type === 'credit_card' ? 'Tarjeta de crédito' : 'Transferencia' }).catch(() => {}); }
for (const d of [90, 60, 30, 3]) await call('POST', '/api/transactions', { type: 'expense', amount: L(250), account_id: bank.id, category_id: cat('Suscripciones'), merchant: 'Netflix', occurred_at: day(d) }).catch(() => {});
await call('POST', '/api/transactions', { type: 'transfer', amount: L(1500), account_id: bank.id, to_account_id: cash.id, occurred_at: day(5) });
await call('POST', '/api/transactions', { type: 'transfer', amount: L(4000), account_id: bank.id, to_account_id: card.id, occurred_at: day(12) });
for (const [c, a] of [['Alimentación', 5000], ['Transporte', 2500], ['Entretenimiento', 1200], ['Compras personales', 1500], ['Servicios', 2200]]) await call('PUT', '/api/budgets', { category_id: cat(c), period: 'monthly', amount: L(a) });
const g1 = await call('POST', '/api/goals', { name: 'Teléfono nuevo', target_amount: L(18000), target_date: new Date(Date.now() + 150 * 86400000).toISOString().slice(0, 10), priority: 2 });
const g2 = await call('POST', '/api/goals', { name: 'Fondo de emergencia', target_amount: L(60000), priority: 1 });
await call('POST', `/api/goals/${g1.id}/contribute`, { account_id: bank.id, amount: L(3500) });
await call('POST', `/api/goals/${g2.id}/contribute`, { account_id: bank.id, amount: L(5000) });
await call('POST', '/api/debts', { direction: 'owe', counterparty: 'Carlos Méndez', original_amount: L(3000), due_date: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10) });
await call('POST', '/api/debts', { direction: 'owed', counterparty: 'María López', original_amount: L(1200), due_date: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) });
await call('POST', '/api/recurring', { name: 'Alquiler', kind: 'bill', amount: L(5500), frequency: 'monthly', next_date: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10), account_id: bank.id, category_id: cat('Hogar') });
await call('POST', '/api/recurring', { name: 'Netflix', kind: 'subscription', amount: L(250), frequency: 'monthly', next_date: new Date(Date.now() + 27 * 86400000).toISOString().slice(0, 10), account_id: bank.id, category_id: cat('Suscripciones') });
await call('POST', '/api/transactions', { type: 'expense', amount: L(185), account_id: bank.id, merchant: 'Cafetería Paradiso', source: 'notification', source_label: 'Notificación: BAC', occurred_at: day(0, 8) });
console.log('Datos de demostración cargados. Usuario: demo@nova.local · Contraseña: demo-nova-2026');
