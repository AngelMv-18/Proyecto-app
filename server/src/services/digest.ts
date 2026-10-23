import { Db, one, rows } from '../db.js';
import { budgetsStatus, categoryBreakdown, getUser, incomeExpense, periodBounds, upcomingObligations } from './stats.js';
import { fmtMoney } from './format.js';

export type Period = 'day' | 'week' | 'month';
const LABEL: Record<Period, [string, string]> = { day: ['Resumen del día', 'ayer'], week: ['Resumen de la semana', 'la semana anterior'], month: ['Resumen del mes', 'el mes anterior'] };

/** Resumen de un período calendario (offset 0 = actual, -1 = anterior) calculado con movimientos confirmados. */
export async function buildDigest(db: Db, userId: string, period: Period, offset = 0) {
  const u = await getUser(db, userId);
  const cur = u.currency;
  const p = await periodBounds(db, u.timezone, period, offset);
  const prev = await periodBounds(db, u.timezone, period, offset - 1);
  const f = { from: p.start, to: p.end };
  const [now, before, cats, top, pending] = await Promise.all([
    incomeExpense(db, userId, cur, f),
    incomeExpense(db, userId, cur, { from: prev.start, to: prev.end }),
    categoryBreakdown(db, userId, cur, f),
    rows(db, `SELECT t.amount, t.merchant, t.occurred_at, c.name AS category FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
       WHERE t.user_id=$1 AND t.status='confirmed' AND t.type='expense' AND t.debt_id IS NULL AND t.currency=$2 AND t.occurred_at >= $3 AND t.occurred_at < $4 ORDER BY t.amount DESC LIMIT 3`, [userId, cur, p.start, p.end]),
    one<{ n: number }>(db, `SELECT count(*)::int n FROM transactions WHERE user_id=$1 AND status='pending' AND occurred_at >= $2 AND occurred_at < $3`, [userId, p.start, p.end]),
  ]);
  const budgets = period === 'day' ? [] : (await budgetsStatus(db, userId, cur, u.timezone)).filter((b) => b.period === (period === 'week' ? 'weekly' : 'monthly') && offset === 0);
  const obligations = (await upcomingObligations(db, userId, cur, u.timezone, 7)).filter((o) => !o.overdue);
  const m = (x: number) => fmtMoney(x, cur, u.locale);
  const lines: string[] = [];
  lines.push(`Ingresos ${m(now.income)} · gastos ${m(now.expense)} · neto ${m(now.net)}.`);
  if (before.expense > 0) {
    const pct = Math.round(((now.expense - before.expense) / before.expense) * 100);
    lines.push(`Gastaste ${Math.abs(pct)}% ${pct >= 0 ? 'más' : 'menos'} que ${LABEL[period][1]} (${m(before.expense)}).`);
  }
  if (cats[0]) lines.push(`Categoría principal: ${cats[0].name} (${m(cats[0].total)}).`);
  const over = budgets.filter((b) => b.pct >= 90);
  if (over.length) lines.push(`Presupuestos al límite: ${over.map((b) => `${b.category_name} ${Math.round(b.pct)}%`).join(', ')}.`);
  if (obligations.length) lines.push(`Próximos 7 días: ${obligations.length} pago(s) por ${m(obligations.reduce((s, o) => s + o.amount, 0))}.`);
  if (pending!.n) lines.push(`${pending!.n} movimiento(s) del período esperan revisión y no están incluidos.`);
  if (now.tx_count === 0) lines.splice(0, lines.length, 'Sin movimientos confirmados en este período.');
  return {
    period, offset, title: LABEL[period][0], from: p.start, to: p.end, currency: cur,
    summary: now, previous: before, categories: cats.slice(0, 5), top_expenses: top, budgets, obligations,
    pending_review: pending!.n, lines,
    quality: pending!.n ? 'incompleto' : 'real',
  };
}
