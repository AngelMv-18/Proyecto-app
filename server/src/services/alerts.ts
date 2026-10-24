import { Db, one, rows } from '../db.js';
import { budgetsStatus, debtsWithRemaining, getUser, goalsWithProgress, upcomingObligations, LIQUID_TYPES, accountsWithBalances } from './stats.js';
import { fmtMoney, median } from './format.js';

export const DEFAULT_ALERT_PREFS = {
  budget: true, large_expense_limit: null as number | null, low_balance: true, subscriptions: true,
  goals: true, review: true, duplicates: true, reconciliation: true, unusual: true,
};
export type AlertPrefs = typeof DEFAULT_ALERT_PREFS;

type N = { kind: string; severity: 'info' | 'warning' | 'critical'; title: string; body: string; key: string; data?: object };

/**
 * Genera alertas idempotentes (clave de deduplicación) para evitar saturar: cada hecho avisa una sola vez.
 * Se invoca tras cambios en movimientos y al abrir el panel.
 */
export async function refreshAlerts(db: Db, userId: string) {
  const u = await getUser(db, userId);
  const prefs: AlertPrefs = { ...DEFAULT_ALERT_PREFS, ...(u.settings?.alerts ?? {}) };
  const cur = u.currency, tz = u.timezone;
  const out: N[] = [];
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d`, [tz]))!.d;

  if (prefs.budget) {
    for (const b of await budgetsStatus(db, userId, cur, tz)) {
      if (b.level >= 50) {
        const sev = b.level >= 100 ? 'critical' : b.level >= 90 ? 'warning' : 'info';
        out.push({ kind: 'budget', severity: sev, key: `budget:${b.id}:${b.period_start}:${b.level}`, title: `Presupuesto de ${b.category_name} al ${b.level}%`,
          body: `Llevas ${fmtMoney(b.spent, cur, u.locale)} de ${fmtMoney(b.amount, cur, u.locale)} (${b.pct}%). ${b.remaining >= 0 ? `Te quedan ${fmtMoney(b.remaining, cur, u.locale)}.` : `Excedido por ${fmtMoney(-b.remaining, cur, u.locale)}.`}`, data: { budget_id: b.id } });
      }
    }
  }
  if (prefs.large_expense_limit) {
    for (const t of await rows(db, `SELECT id, amount, merchant FROM transactions WHERE user_id=$1 AND status='confirmed' AND type='expense' AND currency=$2 AND amount >= $3 AND occurred_at > now() - interval '3 days'`, [userId, cur, prefs.large_expense_limit])) {
      out.push({ kind: 'large_expense', severity: 'warning', key: `large:${t.id}`, title: 'Gasto por encima de tu límite', body: `${fmtMoney(t.amount, cur, u.locale)}${t.merchant ? ` en ${t.merchant}` : ''} supera el límite de ${fmtMoney(prefs.large_expense_limit, cur, u.locale)}.`, data: { tx_id: t.id } });
    }
  }
  if (prefs.low_balance) {
    const accs = (await accountsWithBalances(db, userId)).filter((a) => !a.archived && !a.linked_account_id && a.currency === cur && LIQUID_TYPES.includes(a.type));
    const liquid = accs.reduce((s, a) => s + a.balance, 0);
    const obl = (await upcomingObligations(db, userId, cur, tz, 14)).reduce((s, o) => s + o.amount, 0);
    if (accs.length && obl > 0 && liquid - obl < 0) {
      out.push({ kind: 'low_balance', severity: 'critical', key: `lowbal:${today}`, title: 'Posible saldo insuficiente', body: `En 14 días tienes compromisos por ${fmtMoney(obl, cur, u.locale)} y tu saldo disponible es ${fmtMoney(liquid, cur, u.locale)}. Es una proyección con lo que has registrado.` });
    }
    for (const a of accs) if (a.balance < 0) out.push({ kind: 'negative_balance', severity: 'warning', key: `neg:${a.id}:${today}`, title: `Saldo negativo en ${a.name}`, body: `El saldo calculado es ${fmtMoney(a.balance, cur, u.locale)}. Revisa si falta registrar un ingreso o una transferencia.` });
  }
  if (prefs.subscriptions) {
    for (const r of await rows(db, `SELECT * FROM recurring WHERE user_id=$1 AND active AND next_date <= (now() AT TIME ZONE $2)::date + 3`, [userId, tz])) {
      out.push({ kind: 'subscription', severity: r.next_date < today ? 'warning' : 'info', key: `sub:${r.id}:${r.next_date}`, title: `${r.name}: ${r.next_date < today ? 'pago vencido' : 'próximo cobro'}`, body: `${fmtMoney(r.amount, r.currency, u.locale)} el ${r.next_date}.`, data: { recurring_id: r.id } });
    }
  }
  if (prefs.goals) {
    for (const g of (await goalsWithProgress(db, userId)).filter((g) => g.status === 'active' && g.behind)) {
      out.push({ kind: 'goal_behind', severity: 'warning', key: `goal:${g.id}:${today.slice(0, 7)}`, title: `Meta "${g.name}" va retrasada`, body: g.monthly_needed ? `Para llegar a tiempo necesitas ahorrar ≈ ${fmtMoney(g.monthly_needed, cur, u.locale)} al mes.` : 'La fecha objetivo ya pasó o tu ritmo actual no alcanza.' });
    }
  }
  if (prefs.review) {
    const r = (await one<{ n: number; ask: number }>(db, `SELECT count(*)::int n, count(*) FILTER (WHERE account_pending)::int ask FROM transactions WHERE user_id=$1 AND needs_review AND status='pending'`, [userId]))!;
    if (r.n > 0) out.push({ kind: 'review', severity: 'info', key: `review:${today}`, title: `${r.n} movimiento(s) esperan tu revisión`, body: r.ask ? `${r.ask} necesita(n) que elijas de qué tarjeta o cuenta son. Los movimientos detectados no afectan tus saldos hasta que los confirmes.` : 'Los movimientos detectados no afectan tus saldos hasta que los confirmes.' });
  }
  if (prefs.duplicates) {
    for (const t of await rows(db, `SELECT id, amount, merchant, currency FROM transactions WHERE user_id=$1 AND needs_review AND status='pending' AND duplicate_of IS NOT NULL`, [userId])) {
      out.push({ kind: 'duplicate', severity: 'warning', key: `dup:${t.id}`, title: 'Posible movimiento duplicado', body: `${fmtMoney(t.amount, t.currency, u.locale)}${t.merchant ? ` en ${t.merchant}` : ''} se parece a otro ya registrado. Puede ser una compra repetida real; revísalo.`, data: { tx_id: t.id } });
    }
  }
  if (prefs.reconciliation) {
    for (const r of await rows(db, `SELECT DISTINCT ON (r.account_id) r.*, a.name FROM reconciliations r JOIN accounts a ON a.id=r.account_id WHERE r.user_id=$1 AND NOT a.archived ORDER BY r.account_id, r.created_at DESC`, [userId])) {
      if (r.difference !== 0 && !r.adjustment_tx) out.push({ kind: 'reconciliation', severity: 'warning', key: `recon:${r.id}`, title: `Diferencia de conciliación en ${r.name}`, body: `El saldo del banco (${fmtMoney(r.bank_balance, cur, u.locale)}) difiere del de la app por ${fmtMoney(Math.abs(r.difference), cur, u.locale)} al ${r.as_of}.` });
    }
  }
  if (prefs.unusual) {
    // Inusual ≠ fraudulento: solo se marca para revisión.
    for (const t of await rows(db, `SELECT t.id, t.amount, t.merchant, t.category_id FROM transactions t WHERE t.user_id=$1 AND t.status='confirmed' AND t.type='expense' AND t.currency=$2 AND t.category_id IS NOT NULL AND t.occurred_at > now() - interval '3 days'`, [userId, cur])) {
      const hist = (await rows<{ amount: number }>(db, `SELECT amount FROM transactions WHERE user_id=$1 AND category_id=$2 AND status='confirmed' AND type='expense' AND id<>$3 AND occurred_at > now() - interval '120 days'`, [userId, t.category_id, t.id])).map((r) => r.amount);
      if (hist.length >= 5 && t.amount > median(hist) * 4) out.push({ kind: 'unusual', severity: 'info', key: `unusual:${t.id}`, title: 'Movimiento que requiere revisión', body: `${fmtMoney(t.amount, cur, u.locale)}${t.merchant ? ` en ${t.merchant}` : ''} es bastante mayor que tus gastos habituales en esa categoría. Confirma que lo reconoces.`, data: { tx_id: t.id } });
    }
  }

  let created = 0;
  for (const n of out) {
    const r = await db.query(
      `INSERT INTO notifications(user_id,kind,severity,title,body,dedupe_key,data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [userId, n.kind, n.severity, n.title, n.body, n.key, JSON.stringify(n.data ?? {})],
    );
    created += r.rowCount ?? 0;
  }
  return created;
}
