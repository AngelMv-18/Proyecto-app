import { Db, one, rows } from '../db.js';
import { LIQUID_TYPES, accountsWithBalances, budgetsStatus, categoryBreakdown, dailyBalance, debtsWithRemaining, getUser, goalsWithProgress, incomeExpense, listTransactions, monthlySeries, natureBreakdown, nextOccurrence, periodBounds, upcomingObligations } from './stats.js';
import { clamp, fmtMoney, median } from './format.js';

const DAY = 86400000;

/** Promedios mensuales sobre los últimos 90 días de datos confirmados (honesto sobre cuántos datos hay). */
export async function baseline(db: Db, userId: string, currency: string, tz: string) {
  const first = await one<{ d: Date | null }>(db, `SELECT min(occurred_at) d FROM transactions WHERE user_id=$1 AND status='confirmed'`, [userId]);
  const spanDays = first?.d ? Math.min((Date.now() - first.d.getTime()) / DAY, 90) : 0;
  const from = new Date(Date.now() - 90 * DAY).toISOString();
  const ie = await incomeExpense(db, userId, currency, { from });
  const nat = await natureBreakdown(db, userId, currency, { from });
  const months = Math.max(spanDays, 14) / 30.4375;
  const essential = nat.find((n) => n.nature === 'essential')?.total ?? 0;
  return {
    span_days: Math.round(spanDays),
    months,
    avg_income: Math.round(ie.income / months),
    avg_expense: Math.round(ie.expense / months),
    avg_net: Math.round(ie.net / months),
    avg_essential: Math.round(essential / months),
    sufficient: spanDays >= 30 && ie.tx_count >= 10,
  };
}

export async function liquidSummary(db: Db, userId: string, currency: string) {
  const accs = await accountsWithBalances(db, userId);
  const base = accs.filter((a) => !a.archived && a.currency === currency);
  const liquid = base.filter((a) => LIQUID_TYPES.includes(a.type)).reduce((s, a) => s + a.balance, 0);
  const reserved = base.filter((a) => LIQUID_TYPES.includes(a.type)).reduce((s, a) => s + a.reserved_virtual, 0);
  const cards_owed = base.filter((a) => a.type === 'credit_card').reduce((s, a) => s + a.owed, 0);
  const foreign = accs.filter((a) => !a.archived && a.currency !== currency);
  return { accs, liquid, reserved, cards_owed, foreign, free: liquid - reserved };
}

export async function healthScore(db: Db, userId: string, currency: string, tz: string) {
  const b = await baseline(db, userId, currency, tz);
  const ls = await liquidSummary(db, userId, currency);
  const budgets = await budgetsStatus(db, userId, currency, tz);
  const debts = (await debtsWithRemaining(db, userId)).filter((d) => d.direction === 'owe' && d.status === 'open' && d.currency === currency);
  const obligations = await upcomingObligations(db, userId, currency, tz, 30);
  const parts: { key: string; label: string; weight: number; score: number | null; detail: string }[] = [];

  const rate = b.avg_income > 0 ? b.avg_net / b.avg_income : null;
  parts.push({ key: 'savings', label: 'Tasa de ahorro', weight: 30, score: rate == null ? null : Math.round(clamp(rate / 0.2) * 100), detail: rate == null ? 'Sin ingresos registrados en el período' : `${(rate * 100).toFixed(0)}% de tus ingresos (meta orientativa: 20%)` });
  const monthsCover = b.avg_essential > 0 ? ls.liquid / b.avg_essential : null;
  parts.push({ key: 'emergency', label: 'Colchón de emergencia', weight: 25, score: monthsCover == null ? null : Math.round(clamp(monthsCover / 6) * 100), detail: monthsCover == null ? 'Sin gastos esenciales registrados' : `${monthsCover.toFixed(1)} meses de gastos esenciales (meta orientativa: 6)` });
  const withLimit = budgets.length;
  parts.push({ key: 'budget', label: 'Cumplimiento de presupuestos', weight: 20, score: withLimit ? Math.round((budgets.filter((x) => x.pct <= 100).length / withLimit) * 100) : null, detail: withLimit ? `${budgets.filter((x) => x.pct <= 100).length} de ${withLimit} dentro del límite` : 'Aún no defines presupuestos' });
  const debtTotal = debts.reduce((s, d) => s + d.remaining, 0) + ls.cards_owed;
  const ratio = b.avg_income > 0 ? debtTotal / (b.avg_income * 6) : null;
  parts.push({ key: 'debt', label: 'Carga de deudas', weight: 15, score: ratio == null ? (debtTotal === 0 ? 100 : null) : Math.round((1 - clamp(ratio)) * 100), detail: debtTotal === 0 ? 'Sin deudas propias registradas' : `Deudas = ${fmtMoney(debtTotal, currency)}` });
  const oblTotal = obligations.reduce((s, o) => s + o.amount, 0);
  parts.push({ key: 'liquidity', label: 'Cobertura de compromisos', weight: 10, score: oblTotal === 0 ? (ls.liquid > 0 ? 100 : null) : Math.round(clamp((ls.liquid / oblTotal - 1) / 1) * 100), detail: oblTotal === 0 ? 'Sin compromisos próximos registrados' : `${(ls.liquid / oblTotal).toFixed(1)}× tus compromisos de 30 días` });

  const used = parts.filter((p) => p.score != null);
  const w = used.reduce((s, p) => s + p.weight, 0);
  // Sin historial real no hay indicador: los factores "sin deudas"/"sin compromisos" por sí solos darían 100 engañosos.
  const score = w && b.span_days >= 7 ? Math.round(used.reduce((s, p) => s + (p.score as number) * p.weight, 0) / w) : null;
  return {
    score,
    label: score == null ? 'Sin datos suficientes' : score >= 75 ? 'Sólida' : score >= 50 ? 'Estable' : score >= 30 ? 'Frágil' : 'En riesgo',
    insufficient: !b.sufficient,
    note: b.sufficient ? 'Estimación basada en tus últimos 90 días registrados.' : `Datos insuficientes (${b.span_days} días de historial): el indicador es preliminar.`,
    parts,
  };
}

export async function dashboard(db: Db, userId: string) {
  const u = await getUser(db, userId);
  const cur = u.currency;
  const month = await periodBounds(db, u.timezone, 'month');
  const prev = await periodBounds(db, u.timezone, 'month', -1);
  const [ls, thisM, prevM, cats, budgets, goals, debts, obligations, health, recent, series] = await Promise.all([
    liquidSummary(db, userId, cur),
    incomeExpense(db, userId, cur, { from: month.start, to: month.end }),
    incomeExpense(db, userId, cur, { from: prev.start, to: prev.end }),
    categoryBreakdown(db, userId, cur, { from: month.start, to: month.end }),
    budgetsStatus(db, userId, cur, u.timezone),
    goalsWithProgress(db, userId),
    debtsWithRemaining(db, userId),
    upcomingObligations(db, userId, cur, u.timezone, 30),
    healthScore(db, userId, cur, u.timezone),
    listTransactions(db, userId, {}, 8),
    monthlySeries(db, userId, cur, u.timezone, 6),
  ]);
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d, ((now() AT TIME ZONE $1)::date - 29)::text d0`, [u.timezone]))!;
  const d0 = (await one<{ d0: string }>(db, `SELECT ((now() AT TIME ZONE $1)::date - 29)::text d0`, [u.timezone]))!.d0;
  const balanceSeries = await dailyBalance(db, userId, cur, u.timezone, d0, today.d);
  const reviewCount = (await one<{ n: number }>(db, `SELECT count(*)::int n FROM transactions WHERE user_id=$1 AND needs_review AND status='pending'`, [userId]))!.n;
  const owe = debts.filter((d) => d.direction === 'owe' && d.status === 'open' && d.currency === cur).reduce((s, d) => s + d.remaining, 0);
  const owed = debts.filter((d) => d.direction === 'owed' && d.status === 'open' && d.currency === cur).reduce((s, d) => s + d.remaining, 0);
  const committed = obligations.reduce((s, o) => s + o.amount, 0);
  const totalBudget = budgets.filter((b) => b.period === 'monthly').reduce((s, b) => s + b.amount, 0);
  const spentBudget = budgets.filter((b) => b.period === 'monthly').reduce((s, b) => s + b.spent, 0);
  const alerts = await rows(db, `SELECT * FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 5`, [userId]);
  const accsBase = ls.accs.filter((a) => !a.archived && a.currency === cur);
  const net_worth = accsBase.reduce((s, a) => s + a.balance, 0) + owed - owe;
  return {
    currency: cur, period: month,
    available: ls.liquid, reserved: ls.reserved, committed, free_to_spend: ls.free - committed,
    net_worth, receivable: owed, payable: owe, cards_owed: ls.cards_owed,
    month: thisM, prev_month: prevM,
    budget: { total: totalBudget, spent: spentBudget, pct: totalBudget ? Math.round((spentBudget / totalBudget) * 1000) / 10 : null },
    accounts: ls.accs.filter((a) => !a.archived), foreign_accounts: ls.foreign.length,
    categories: cats, budgets, goals: goals.filter((g) => g.status === 'active'),
    obligations: obligations.slice(0, 6), health, recent: recent.items, monthly: series, balance_series: balanceSeries,
    review_count: reviewCount, alerts,
    data_quality: { pending_review: reviewCount, foreign_currency_accounts_excluded: ls.foreign.length, history_days: health.insufficient ? null : undefined },
  };
}

// ---------- Evaluador de compras: ¿me conviene comprarlo? ----------
export type PurchaseInput = {
  item: string; price: number; payment: 'cash' | 'debit' | 'credit' | 'installments'; installments?: number; installments_total?: number;
  kind: 'need' | 'want'; date?: string; extra_costs?: number; category_id?: string | null; goal_id?: string | null;
};

export async function evaluatePurchase(db: Db, userId: string, p: PurchaseInput) {
  const u = await getUser(db, userId);
  const cur = u.currency;
  const total = p.price + (p.extra_costs ?? 0);
  const [b, ls] = await Promise.all([baseline(db, userId, cur, u.timezone), liquidSummary(db, userId, cur)]);
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d`, [u.timezone]))!.d;
  const buyDate = p.date && p.date > today ? p.date : today;
  const daysAhead = Math.round((new Date(buyDate).getTime() - new Date(today).getTime()) / DAY);
  const horizon = Math.min(daysAhead + 30, 120);
  const obligations = await upcomingObligations(db, userId, cur, u.timezone, horizon);
  const oblTotal = obligations.reduce((s, o) => s + o.amount, 0);
  const goals = (await goalsWithProgress(db, userId)).filter((g) => g.status === 'active' && g.missing > 0);
  const target = p.goal_id ? goals.find((g) => g.id === p.goal_id) : goals.filter((g) => g.priority === 1)[0] ?? goals[0];

  const assumptions: string[] = [
    `Moneda: ${cur}. Se usa el saldo libre (disponible menos lo reservado en metas virtuales): ${fmtMoney(ls.free, cur)}.`,
    `Compromisos considerados hasta ${horizon} días: ${fmtMoney(oblTotal, cur)} (solo los que ya registraste).`,
    'No se cuentan ingresos futuros: la evaluación es conservadora.',
  ];
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!b.sufficient) warnings.push(`Historial limitado (${b.span_days} días / pocos movimientos): los promedios son poco fiables.`);
  if (ls.accs.filter((a) => !a.archived).length === 0) warnings.push('No tienes cuentas registradas: no puedo calcular tu saldo real.');
  if (ls.foreign.length) warnings.push(`Hay ${ls.foreign.length} cuenta(s) en otra moneda que no se incluyen en el cálculo.`);

  // Impacto inmediato en caja según el medio de pago.
  const cashNow = p.payment === 'cash' || p.payment === 'debit';
  const n = Math.max(p.installments ?? 1, 1);
  const installmentTotal = p.installments_total ?? total;
  const monthlyPayment = p.payment === 'installments' ? Math.ceil(installmentTotal / n) : p.payment === 'credit' ? total : 0;
  const cashImpactNow = cashNow ? total : 0;
  const cashImpact30 = p.payment === 'installments' ? monthlyPayment : p.payment === 'credit' ? total : cashImpactNow;
  const afterObl = ls.free - oblTotal - cashImpact30;
  const cushion = b.avg_essential; // un mes de gastos esenciales
  const monthsEssLeft = b.avg_essential > 0 ? Math.max(ls.free - cashImpact30, 0) / b.avg_essential : null;

  reasons.push(`Saldo libre: ${fmtMoney(ls.free, cur)}. Compromisos próximos: ${fmtMoney(oblTotal, cur)}. Costo total de la compra: ${fmtMoney(total, cur)}.`);
  reasons.push(`Dinero libre tras compromisos y compra: ${fmtMoney(afterObl, cur)}${cushion ? ` (un mes de gastos esenciales ≈ ${fmtMoney(cushion, cur)})` : ''}.`);
  if (installmentTotal > total && p.payment === 'installments') reasons.push(`Con cuotas pagarías ${fmtMoney(installmentTotal, cur)} en total: ${fmtMoney(installmentTotal - total, cur)} más que al contado.`);

  // Presupuesto restante de la categoría.
  let budgetOk: boolean | null = null;
  if (p.category_id) {
    const bs = (await budgetsStatus(db, userId, cur, u.timezone)).filter((x) => x.category_id === p.category_id && x.period === 'monthly');
    if (bs[0]) {
      budgetOk = bs[0].remaining >= total;
      reasons.push(`Presupuesto mensual de ${bs[0].category_name}: te quedan ${fmtMoney(Math.max(bs[0].remaining, 0), cur)} de ${fmtMoney(bs[0].amount, cur)}${budgetOk ? '' : ' → la compra lo excedería'}.`);
    } else reasons.push('Esa categoría no tiene presupuesto mensual definido.');
  }

  // Meta prioritaria y recuperación.
  const monthlyNet = b.avg_net;
  let goalDelayDays: number | null = null;
  if (target && total > 0 && p.kind === 'want') {
    if (monthlyNet > 0) goalDelayDays = Math.round((total / monthlyNet) * 30.4375);
    reasons.push(monthlyNet > 0
      ? `Tu ahorro neto promedio es ${fmtMoney(monthlyNet, cur)}/mes; gastar ${fmtMoney(total, cur)} equivale a ~${Math.round((total / monthlyNet) * 10) / 10} meses de ahorro y retrasaría "${target.name}" unos ${goalDelayDays} días.`
      : `No registras ahorro neto positivo (${fmtMoney(monthlyNet, cur)}/mes): la compra no se puede compensar con tu ritmo actual y afectaría "${target.name}".`);
  }
  const paybackMonths = monthlyNet > 0 ? Math.round((total / monthlyNet) * 10) / 10 : null;
  reasons.push(paybackMonths != null ? `Recuperar este dinero con tu ahorro actual tomaría ≈ ${paybackMonths} meses.` : 'Con tu ahorro neto actual no se puede estimar cuándo recuperarías este dinero.');

  // Veredicto (orientativo, nunca aprobación automática).
  let verdict: 'compatible' | 'plan' | 'delays_goal' | 'risk_obligations';
  if (afterObl < 0) verdict = 'risk_obligations';
  else if (p.kind === 'want' && target && (monthlyNet <= 0 || (goalDelayDays ?? 0) > 30)) verdict = 'delays_goal';
  else if ((cushion && afterObl < cushion) || budgetOk === false || p.payment === 'credit' || p.payment === 'installments' || !b.sufficient) verdict = 'plan';
  else verdict = 'compatible';

  const headline = {
    compatible: 'Compra compatible con tu presupuesto',
    plan: 'Compra posible, pero conviene planificarla',
    delays_goal: 'Compra que retrasaría una meta importante',
    risk_obligations: 'Compra que podría poner en riesgo tus obligaciones esenciales',
  }[verdict];

  // Alternativas prácticas (nunca recomendar deuda para facilitar la compra).
  const alternatives: string[] = [];
  const weeksToSave = (amount: number) => {
    const perWeek = monthlyNet > 0 ? monthlyNet / 4.345 : 0;
    return perWeek > 0 ? Math.ceil(amount / perWeek) : null;
  };
  const shortfall = Math.max(total - Math.max(ls.free - oblTotal, 0), 0);
  let savings_plan: null | { weekly: number; weeks: number; monthly: number; note: string } = null;
  if (shortfall > 0 || verdict !== 'compatible') {
    const need = shortfall > 0 ? shortfall + (cushion ? Math.round(cushion * 0.25) : 0) : total;
    const w = Math.max(daysAhead / 7, weeksToSave(need) ?? 8, 1);
    const weeks = Math.ceil(w);
    savings_plan = { weekly: Math.ceil(need / weeks), weeks, monthly: Math.ceil(need / (weeks / 4.345)), note: monthlyNet > 0 && need / weeks > monthlyNet / 4.345 ? 'Este aporte supera tu ahorro neto actual: requeriría recortar gastos.' : 'Plan orientativo para llegar con holgura.' };
    alternatives.push(`Ahorrar ${fmtMoney(savings_plan.weekly, cur)} por semana durante ~${savings_plan.weeks} semanas antes de comprar.`);
  }
  alternatives.push(`Buscar una opción ~20 % más barata ahorraría ≈ ${fmtMoney(Math.round(total * 0.2), cur)}.`);
  if (p.kind === 'want') alternatives.push('Esperar 30 días antes de decidir: si el deseo persiste, la compra suele ser más acertada.');
  if (p.payment === 'credit' || p.payment === 'installments') {
    alternatives.push(ls.free - oblTotal >= total ? 'Pagar de contado evitaría intereses y deuda.' : 'No recomiendo financiarla: hoy tu dinero libre no cubre el costo; mejor planificar el ahorro o elegir una opción menor.');
  }
  if (verdict === 'risk_obligations') warnings.push('Comprarla ahora te dejaría sin dinero suficiente para tus compromisos registrados.');

  return {
    item: p.item, verdict, headline, total_cost: total, reasons, warnings, alternatives, savings_plan, assumptions,
    numbers: { free: ls.free, obligations: oblTotal, after: afterObl, cushion, months_essentials_left: monthsEssLeft, payback_months: paybackMonths, goal_delay_days: goalDelayDays, avg_monthly_net: monthlyNet, monthly_payment: monthlyPayment },
    goal: target ? { id: target.id, name: target.name } : null,
    disclaimer: 'Evaluación orientativa basada solo en lo que has registrado. La decisión es tuya; NOVA no aprueba ni rechaza compras.',
    confidence: b.sufficient ? 'media' : 'baja',
    period: { baseline_days: b.span_days, horizon_days: horizon },
  };
}

// ---------- Sugerencias de recurrencias (requieren confirmación del usuario) ----------
export async function suggestRecurring(db: Db, userId: string) {
  const u = await getUser(db, userId);
  const txs = await rows(db, `SELECT merchant, amount, occurred_at, account_id, category_id FROM transactions
       WHERE user_id=$1 AND status='confirmed' AND type='expense' AND debt_id IS NULL AND merchant IS NOT NULL AND currency=$2 AND occurred_at > now() - interval '400 days' ORDER BY occurred_at`, [userId, u.currency]);
  const existing = (await rows(db, `SELECT name FROM recurring WHERE user_id=$1`, [userId])).map((r) => r.name.toLowerCase());
  const groups = new Map<string, any[]>();
  for (const t of txs) {
    const k = t.merchant.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out = [];
  for (const [, g] of groups) {
    if (g.length < 3) continue;
    const gaps = g.slice(1).map((t, i) => (t.occurred_at.getTime() - g[i].occurred_at.getTime()) / DAY);
    const gap = median(gaps);
    const amt = median(g.map((t) => t.amount));
    const stable = g.every((t) => Math.abs(t.amount - amt) <= amt * 0.1);
    const freq = gap >= 26 && gap <= 35 ? 'monthly' : gap >= 6 && gap <= 8 ? 'weekly' : gap >= 355 && gap <= 375 ? 'yearly' : null;
    if (!freq || !stable) continue;
    if (existing.some((e) => e.includes(g[0].merchant.toLowerCase()) || g[0].merchant.toLowerCase().includes(e))) continue;
    const last = g[g.length - 1];
    const lastDate = last.occurred_at.toISOString().slice(0, 10);
    out.push({ name: last.merchant, amount: Math.round(amt), frequency: freq, last_date: lastDate, next_date: nextOccurrence(lastDate, freq), occurrences: g.length, account_id: last.account_id, category_id: last.category_id });
  }
  return out;
}
