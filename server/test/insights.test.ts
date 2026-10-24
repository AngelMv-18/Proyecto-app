import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, seededUser } from './helpers.js';

afterAll(closeApp);

async function withHistory() {
  const u = await seededUser();
  // 45 días de historial: ingresos quincenales y gastos esenciales/discrecionales
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  for (const d of [44, 29, 14]) await u.ok(u.post('/api/transactions', { type: 'income', amount: L(6000), account_id: u.bank.id, occurred_at: day(d), category_id: undefined }));
  for (let d = 44; d >= 1; d -= 4) await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(300), account_id: u.cash.id, category_id: u.cat('Alimentación'), occurred_at: day(d), merchant: 'Supermercado' }));
  for (let d = 40; d >= 1; d -= 9) await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(250), account_id: u.cash.id, category_id: u.cat('Entretenimiento'), occurred_at: day(d), merchant: 'Cine' }));
  return u;
}

describe('NOVA AI y evaluador de compras', () => {
  it('sin datos, NOVA AI lo dice expresamente y no inventa cifras', async () => {
    const u = await seededUser();
    const r = await u.ok(u.post('/api/ai/chat', { messages: [{ role: 'user', content: '¿Cuánto gasté en comida este mes?' }] }));
    expect(r.mode).toBe('local');
    expect(r.answer).toMatch(/necesito movimientos confirmados/i);
    expect(r.answer).not.toMatch(/L\s?\d/);
  });

  it('el estado de la IA indica el modo local cuando no hay ANTHROPIC_API_KEY', async () => {
    const u = await seededUser();
    const s = await u.ok(u.get('/api/ai/status'));
    expect(s).toMatchObject({ llm_configured: false, mode: 'local' });
  });

  it('responde con cifras reales de la base de datos', async () => {
    const u = await withHistory();
    const cats = await u.ok(u.get('/api/dashboard'));
    const comida = cats.categories.find((c: any) => c.name === 'Alimentación').total;
    const r = await u.ok(u.post('/api/ai/chat', { messages: [{ role: 'user', content: '¿En qué categoría estoy gastando más?' }] }));
    expect(r.tools_used).toContain('gastos_por_categoria');
    expect(r.answer).toContain('Alimentación');
    const w = await u.ok(u.post('/api/ai/chat', { messages: [{ role: 'user', content: '¿Cuánto puedo gastar esta semana?' }] }));
    expect(w.answer).toMatch(/por semana/);
    expect(w.answer).toMatch(/Supuestos/);
    expect(comida).toBeGreaterThan(0);
  });

  it('evaluador: riesgo para obligaciones cuando no alcanza el dinero libre', async () => {
    const u = await withHistory();
    await u.ok(u.post('/api/recurring', { name: 'Alquiler', kind: 'bill', amount: L(5000), frequency: 'monthly', next_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), account_id: u.bank.id, category_id: u.cat('Hogar') }));
    const r = await u.ok(u.post('/api/purchase/evaluate', { item: 'Laptop', price: L(40000), payment: 'cash', kind: 'want' }));
    expect(r.verdict).toBe('risk_obligations');
    expect(r.headline).toMatch(/riesgo/i);
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.assumptions.length).toBeGreaterThan(0);
    expect(r.disclaimer).toMatch(/decisión es tuya/);
  });

  it('evaluador: una compra pequeña es compatible; no recomienda endeudarse para financiarla', async () => {
    const u = await withHistory();
    const ok = await u.ok(u.post('/api/purchase/evaluate', { item: 'Audífonos', price: L(300), payment: 'cash', kind: 'need' }));
    expect(ok.verdict).toBe('compatible');
    const cr = await u.ok(u.post('/api/purchase/evaluate', { item: 'TV', price: L(30000), payment: 'installments', installments: 12, installments_total: L(36000), kind: 'want' }));
    expect(cr.verdict).not.toBe('compatible');
    expect(cr.alternatives.join(' ')).toMatch(/No recomiendo financiarla/);
    expect(cr.reasons.join(' ')).toMatch(/más que al contado/);
  });

  it('evaluador: una compra deseada que retrasa la meta prioritaria se marca como tal', async () => {
    const u = await withHistory();
    await u.ok(u.post('/api/goals', { name: 'Fondo de emergencia', target_amount: L(30000), priority: 1 }));
    const r = await u.ok(u.post('/api/purchase/evaluate', { item: 'Consola', price: L(15000), payment: 'cash', kind: 'want' }));
    expect(r.verdict).toBe('delays_goal');
    expect(r.reasons.join(' ')).toMatch(/Fondo de emergencia/);
  });

  it('con historial insuficiente advierte baja confianza', async () => {
    const u = await seededUser();
    const r = await u.ok(u.post('/api/purchase/evaluate', { item: 'X', price: L(100), payment: 'cash', kind: 'want' }));
    expect(r.confidence).toBe('baja');
    expect(r.warnings.join(' ')).toMatch(/Historial limitado/);
  });
});

describe('alertas, recurrencias, informes y salud', () => {
  it('genera alertas de presupuesto una sola vez por umbral', async () => {
    const u = await seededUser();
    await u.ok(u.put('/api/budgets', { category_id: u.cat('Alimentación'), period: 'monthly', amount: L(1000) }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(760), account_id: u.cash.id, category_id: u.cat('Alimentación') }));
    await u.ok(u.get('/api/dashboard')); await u.ok(u.get('/api/dashboard'));
    let n = await u.ok(u.get('/api/notifications'));
    expect(n.filter((x: any) => x.kind === 'budget')).toHaveLength(1);
    expect(n[0].title).toContain('75%');
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(300), account_id: u.cash.id, category_id: u.cat('Alimentación') }));
    n = await u.ok(u.get('/api/notifications'));
    expect(n.some((x: any) => x.title.includes('100%') && x.severity === 'critical')).toBe(true);
  });

  it('pagar un recurrente registra el gasto y avanza la fecha; las sugerencias requieren confirmación', async () => {
    const u = await seededUser();
    const r = await u.ok(u.post('/api/recurring', { name: 'Netflix', amount: L(250), frequency: 'monthly', next_date: '2026-01-31', account_id: u.bank.id, category_id: u.cat('Suscripciones') }));
    const p = await u.ok(u.post(`/api/recurring/${r.id}/pay`, {}));
    expect(p.next_date).toBe('2026-02-28');
    expect(p.transaction.amount).toBe(L(250));
    // Sugerencia: 4 pagos mensuales iguales de "Spotify" sin recurrencia creada
    for (const d of [95, 65, 35, 5]) await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(120), account_id: u.bank.id, merchant: 'Spotify', occurred_at: new Date(Date.now() - d * 86400000).toISOString() }));
    const sug = await u.ok(u.get('/api/recurring/suggestions'));
    expect(sug.map((s: any) => s.name)).toContain('Spotify');
    expect((await u.ok(u.get('/api/recurring'))).some((x: any) => x.name === 'Spotify')).toBe(false); // nada se crea sin confirmar
  });

  it('informes: CSV con marca de calidad y sin inyección de fórmulas', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: u.cash.id, category_id: u.cat('Otros'), merchant: '=HYPERLINK("http://x")' }));
    await u.ok(u.post('/api/transactions', { type: 'income', amount: L(900), account_id: u.bank.id }));
    const csv = (await u.get('/api/reports/income_statement?format=csv')).text;
    expect(csv).toContain('Calidad de datos');
    const tx = (await u.get('/api/export/transactions.csv')).text;
    expect(tx).toContain("'=HYPERLINK");
    expect(tx).not.toMatch(/,=HYPERLINK/);
    const j = await u.ok(u.get('/api/reports/income_statement'));
    expect(j.totals.Ingresos).toBe(L(900));
    expect(j.totals.Gastos).toBe(L(100));
    const html = (await u.get('/api/reports/net_worth?format=html')).text;
    expect(html).toContain('Patrimonio neto estimado');
    for (const k of ['cash_flow', 'category_summary', 'balances', 'monthly_comparison', 'debts', 'recurring', 'savings_rate', 'reconciliation']) expect((await u.get(`/api/reports/${k}`)).status, k).toBe(200);
  });

  it('informes marcan datos incompletos cuando hay movimientos pendientes de revisión', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: u.cash.id, source: 'notification', merchant: 'Algo' }));
    const j = await u.ok(u.get('/api/reports/income_statement'));
    expect(j.quality.level).toBe('incompleto');
    expect(j.quality.notes.join(' ')).toMatch(/pendientes de revisión/);
  });

  it('el indicador de salud advierte cuando los datos son insuficientes', async () => {
    const u = await seededUser();
    const d = await u.ok(u.get('/api/dashboard'));
    expect(d.health.insufficient).toBe(true);
    expect(d.health.note).toMatch(/Datos insuficientes/);
  });

  it('búsqueda global, auditoría y comprobantes', async () => {
    const u = await seededUser();
    const t = (await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(10), account_id: u.cash.id, merchant: 'Ferretería Lempira' }))).tx;
    expect((await u.ok(u.get('/api/search?q=Ferret'))).transactions).toHaveLength(1);
    const app = u.app;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await app.inject({ method: 'PUT', url: `/api/transactions/${t.id}/receipt`, headers: { cookie: u.cookie, 'x-requested-with': 'nova', 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(200);
    const down = await app.inject({ method: 'GET', url: `/api/transactions/${t.id}/receipt`, headers: { cookie: u.cookie } });
    expect(down.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(down.rawPayload, png)).toBe(0);
    const bad = await app.inject({ method: 'PUT', url: `/api/transactions/${t.id}/receipt`, headers: { cookie: u.cookie, 'x-requested-with': 'nova', 'content-type': 'text/html' }, payload: '<script>' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const audit = await u.ok(u.get('/api/audit?entity=transaction'));
    expect(audit.map((a: any) => a.action)).toContain('receipt_attached');
  });
});

describe('análisis con filtros', () => {
  it('filtra por cuenta, categoría y método de pago', async () => {
    const u = await seededUser();
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(100), account_id: u.cash.id, category_id: u.cat('Alimentación'), payment_method: 'Efectivo' }));
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(300), account_id: u.card.id, category_id: u.cat('Tecnología'), payment_method: 'Tarjeta' }));
    const all = await u.ok(u.get('/api/analysis'));
    expect(all.summary.expense).toBe(L(400));
    expect(all.payment_methods).toEqual(['Efectivo', 'Tarjeta']);
    expect((await u.ok(u.get(`/api/analysis?account_id=${u.cash.id}`))).summary.expense).toBe(L(100));
    expect((await u.ok(u.get(`/api/analysis?category_id=${u.cat('Tecnología')}`))).summary.expense).toBe(L(300));
    expect((await u.ok(u.get('/api/analysis?payment_method=Tarjeta'))).daily.reduce((s: number, d: any) => s + d.expense, 0)).toBe(L(300));
    expect((await u.ok(u.get('/api/budgets/insights'))).nature).toBeDefined();
  });
});
