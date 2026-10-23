import { Db, one, rows } from '../db.js';

export type Filters = {
  from?: string; to?: string; account_id?: string; category_id?: string; payment_method?: string;
  type?: string; status?: string; q?: string; tag?: string; needs_review?: boolean; source?: string;
};

export async function getUser(db: Db, userId: string) {
  return (await one<{ id: string; currency: string; timezone: string; locale: string; settings: any; display_name: string; email: string }>(
    db, 'SELECT id,email,display_name,currency,timezone,locale,settings FROM users WHERE id=$1', [userId]))!;
}

/** Límites [start,end) de un período calendario en la zona horaria del usuario. */
export async function periodBounds(db: Db, tz: string, kind: 'day' | 'week' | 'month' | 'year', offset = 0) {
  const r = await one<{ s: Date; e: Date }>(
    db,
    `SELECT (date_trunc($2, now() AT TIME ZONE $1) + ($3 || ' ' || $2)::interval) AT TIME ZONE $1 AS s,
            (date_trunc($2, now() AT TIME ZONE $1) + (($3::int + 1) || ' ' || $2)::interval) AT TIME ZONE $1 AS e`,
    [tz, kind, String(offset)],
  );
  return { start: r!.s.toISOString(), end: r!.e.toISOString() };
}

export function whereFilters(f: Filters, params: any[], alias = 't'): string {
  const w: string[] = [];
  const p = (v: any) => { params.push(v); return `$${params.length}`; };
  if (f.from) w.push(`${alias}.occurred_at >= ${p(f.from)}`);
  if (f.to) w.push(`${alias}.occurred_at < ${p(f.to)}`);
  if (f.account_id) { const x = p(f.account_id); w.push(`(${alias}.account_id=${x} OR ${alias}.to_account_id=${x})`); }
  if (f.category_id) { const x = p(f.category_id); w.push(`(${alias}.category_id=${x} OR ${alias}.category_id IN (SELECT id FROM categories WHERE parent_id=${x}))`); }
  if (f.payment_method) w.push(`${alias}.payment_method = ${p(f.payment_method)}`);
  if (f.type) w.push(`${alias}.type = ${p(f.type)}`);
  if (f.status) w.push(`${alias}.status = ${p(f.status)}`);
  if (f.source) w.push(`${alias}.source = ${p(f.source)}`);
  if (f.tag) w.push(`${p(f.tag)} = ANY(${alias}.tags)`);
  if (f.needs_review) w.push(`${alias}.needs_review`);
  if (f.q) { const x = p(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); w.push(`(${alias}.merchant ILIKE ${x} OR ${alias}.description ILIKE ${x})`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

export async function listTransactions(db: Db, userId: string, f: Filters, limit = 50, offset = 0) {
  const params: any[] = [userId];
  const where = whereFilters(f, params);
  const total = await one<{ n: number }>(db, `SELECT count(*)::int n FROM transactions t WHERE t.user_id=$1 ${where}`, params);
  params.push(limit, offset);
  const items = await rows(
    db,
    `SELECT t.*, c.name AS category_name, a.name AS account_name, ta.name AS to_account_name
       FROM transactions t
       LEFT JOIN categories c ON c.id=t.category_id
       LEFT JOIN accounts a ON a.id=t.account_id
       LEFT JOIN accounts ta ON ta.id=t.to_account_id
      WHERE t.user_id=$1 ${where} ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items, total: total!.n };
}

export const LIQUID_TYPES = ['cash', 'bank', 'debit_card', 'wallet', 'savings', 'other'];

export async function accountsWithBalances(db: Db, userId: string) {
  const accs = await rows(
    db,
    `SELECT a.*, a.opening_balance + COALESCE(e.s,0) AS balance,
            (SELECT count(*)::int FROM transactions t WHERE (t.account_id=a.id OR t.to_account_id=a.id) AND t.status='pending') AS pending_count,
            (SELECT row_to_json(r) FROM (SELECT as_of, bank_balance, difference, created_at FROM reconciliations x WHERE x.account_id=a.id ORDER BY created_at DESC LIMIT 1) r) AS last_reconciliation
       FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(delta) s FROM v_effects WHERE user_id=$1 GROUP BY account_id) e ON e.account_id=a.id
      WHERE a.user_id=$1 ORDER BY a.archived, a.sort_order, a.created_at`,
    [userId],
  );
  const reserved = await rows<{ account_id: string; s: number }>(db, `SELECT account_id, SUM(amount) s FROM transactions WHERE user_id=$1 AND type='goal_saving' AND to_account_id IS NULL AND status='confirmed' GROUP BY account_id`, [userId]);
  const rmap = new Map(reserved.map((r) => [r.account_id, r.s]));
  const fx = new Map((await rows<{ currency: string; rate: number }>(db, 'SELECT currency, rate FROM fx_rates WHERE user_id=$1', [userId])).map((r) => [r.currency, r.rate]));
  const base = (await one<{ currency: string }>(db, 'SELECT currency FROM users WHERE id=$1', [userId]))!.currency;
  return accs.map((a) => {
    const out: any = { ...a, reserved_virtual: rmap.get(a.id) ?? 0 };
    // Conversión a la moneda principal con el tipo de cambio que defina el usuario (estimación).
    const rate = a.currency === base ? 1 : fx.get(a.currency) ?? null;
    out.fx_rate = a.currency === base ? null : rate;
    out.balance_base = rate == null ? null : Math.round(a.balance * rate);
    if (a.type === 'credit_card') {
      out.owed = Math.max(-a.balance, 0);
      out.available_credit = a.credit_limit != null ? a.credit_limit - out.owed : null;
    }
    const lr = a.last_reconciliation;
    out.bank_confirmed_balance = lr ? lr.bank_balance : null;
    return out;
  });
}

export async function incomeExpense(db: Db, userId: string, currency: string, f: Filters) {
  const params: any[] = [userId, currency];
  const where = whereFilters(f, params);
  const r = await one(
    db,
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income' AND debt_id IS NULL),0) AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense' AND debt_id IS NULL),0) AS gross_expense,
            COALESCE(SUM(amount) FILTER (WHERE type='refund'),0) AS refunds,
            COALESCE(SUM(amount) FILTER (WHERE type='goal_saving'),0) AS goal_saved,
            COALESCE(SUM(amount) FILTER (WHERE type='adjustment'),0) AS adjustments,
            count(*)::int AS tx_count
       FROM transactions t WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 ${where}`,
    params,
  );
  const expense = r.gross_expense - r.refunds;
  return { income: r.income, expense, refunds: r.refunds, net: r.income - expense, goal_saved: r.goal_saved, adjustments: r.adjustments, tx_count: r.tx_count };
}

export async function categoryBreakdown(db: Db, userId: string, currency: string, f: Filters, nature?: string) {
  const params: any[] = [userId, currency];
  const where = whereFilters(f, params);
  return rows<{ category_id: string | null; name: string; total: number; nature: string | null }>(
    db,
    `SELECT COALESCE(p.id, c.id) AS category_id, COALESCE(p.name, c.name, 'Sin categoría') AS name, COALESCE(p.nature, c.nature) AS nature,
            SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END)::bigint AS total
       FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
      WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.type IN ('expense','refund') AND t.debt_id IS NULL ${where}
      GROUP BY 1,2,3 HAVING SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END) <> 0
      ORDER BY total DESC`,
    params,
  ).then((r) => (nature ? r.filter((x) => x.nature === nature) : r));
}

export async function natureBreakdown(db: Db, userId: string, currency: string, f: Filters) {
  const params: any[] = [userId, currency];
  const where = whereFilters(f, params);
  return rows<{ nature: string; total: number }>(
    db,
    `SELECT COALESCE(t.nature, p.nature, c.nature, 'discretionary') AS nature,
            SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END)::bigint AS total
       FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
      WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.type IN ('expense','refund') AND t.debt_id IS NULL ${where}
      GROUP BY 1`,
    params,
  );
}

/** Saldo diario de las cuentas en la moneda indicada (patrimonio de cuentas, incluye tarjetas como saldo negativo). */
export async function dailyBalance(db: Db, userId: string, currency: string, tz: string, fromDate: string, toDate: string, accountId?: string) {
  return rows<{ day: string; balance: number }>(
    db,
    `WITH accs AS (SELECT id, opening_balance, opening_date FROM accounts WHERE user_id=$1 AND currency=$2 AND ($5::uuid IS NULL OR id=$5)),
          days AS (SELECT generate_series($3::date, $4::date, interval '1 day')::date AS d)
     SELECT days.d::text AS day,
            ((SELECT COALESCE(SUM(opening_balance),0) FROM accs WHERE opening_date <= days.d)
           + (SELECT COALESCE(SUM(e.delta),0) FROM v_effects e JOIN accs ON accs.id=e.account_id WHERE (e.occurred_at AT TIME ZONE $6)::date <= days.d))::bigint AS balance
       FROM days ORDER BY days.d`,
    [userId, currency, fromDate, toDate, accountId ?? null, tz],
  );
}

export async function monthlySeries(db: Db, userId: string, currency: string, tz: string, months = 6) {
  return rows<{ month: string; income: number; expense: number; net: number }>(
    db,
    `WITH m AS (SELECT generate_series(date_trunc('month', now() AT TIME ZONE $3) - (($4::int - 1) || ' months')::interval, date_trunc('month', now() AT TIME ZONE $3), interval '1 month') AS ms)
     SELECT to_char(m.ms, 'YYYY-MM') AS month,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.debt_id IS NULL),0)::bigint AS income,
            (COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.debt_id IS NULL),0) - COALESCE(SUM(t.amount) FILTER (WHERE t.type='refund'),0))::bigint AS expense,
            (COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.debt_id IS NULL),0) - COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.debt_id IS NULL),0) + COALESCE(SUM(t.amount) FILTER (WHERE t.type='refund'),0))::bigint AS net
       FROM m LEFT JOIN transactions t ON t.user_id=$1 AND t.status='confirmed' AND t.currency=$2
            AND (t.occurred_at AT TIME ZONE $3) >= m.ms AND (t.occurred_at AT TIME ZONE $3) < m.ms + interval '1 month'
      GROUP BY m.ms ORDER BY m.ms`,
    [userId, currency, tz, months],
  );
}

/** Gasto neto de una categoría (y sus subcategorías) en [from,to). */
export async function categorySpent(db: Db, userId: string, currency: string, categoryId: string, from: string, to: string) {
  const r = await one<{ s: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END),0)::bigint s
       FROM transactions t
      WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.type IN ('expense','refund') AND t.debt_id IS NULL
        AND t.occurred_at >= $4 AND t.occurred_at < $5
        AND (t.category_id=$3 OR t.category_id IN (SELECT id FROM categories WHERE parent_id=$3))`,
    [userId, currency, categoryId, from, to],
  );
  return r!.s;
}

export const THRESHOLDS = [50, 75, 90, 100];

export async function budgetsStatus(db: Db, userId: string, currency: string, tz: string) {
  const budgets = await rows(db, `SELECT b.*, c.name AS category_name, c.nature FROM budgets b JOIN categories c ON c.id=b.category_id WHERE b.user_id=$1 ORDER BY c.name`, [userId]);
  const month = await periodBounds(db, tz, 'month');
  const week = await periodBounds(db, tz, 'week');
  const now = Date.now();
  const out = [];
  for (const b of budgets) {
    const per = b.period === 'monthly' ? month : week;
    const spent = await categorySpent(db, userId, currency, b.category_id, per.start, per.end);
    const total = new Date(per.end).getTime() - new Date(per.start).getTime();
    const elapsed = Math.min(Math.max((now - new Date(per.start).getTime()) / total, 0.01), 1);
    const pct = (spent / b.amount) * 100;
    out.push({
      ...b, spent, remaining: b.amount - spent, pct: Math.round(pct * 10) / 10, period_start: per.start, period_end: per.end,
      projected: Math.round(spent / elapsed), // proyección lineal; es una estimación
      level: THRESHOLDS.filter((t) => pct >= t).pop() ?? 0,
    });
  }
  return out;
}

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z'); const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
};
export function nextOccurrence(date: string, freq: string) {
  switch (freq) {
    case 'weekly': return addDays(date, 7);
    case 'biweekly': return addDays(date, 14);
    case 'monthly': return addMonths(date, 1);
    default: return addMonths(date, 12);
  }
}

export type Obligation = { kind: 'recurring' | 'debt'; id: string; name: string; date: string; amount: number; account_id?: string | null; overdue: boolean };

/** Compromisos futuros en los próximos N días: recurrencias expandidas y deudas propias con vencimiento. */
export async function upcomingObligations(db: Db, userId: string, currency: string, tz: string, days = 30): Promise<Obligation[]> {
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d`, [tz]))!.d;
  const horizon = addDays(today, days);
  const out: Obligation[] = [];
  const rec = await rows(db, `SELECT * FROM recurring WHERE user_id=$1 AND active AND currency=$2`, [userId, currency]);
  for (const r of rec) {
    let d: string = r.next_date;
    let guard = 0;
    while (d <= horizon && guard++ < 60) {
      out.push({ kind: 'recurring', id: r.id, name: r.name, date: d, amount: r.amount, account_id: r.account_id, overdue: d < today });
      d = nextOccurrence(d, r.frequency);
    }
  }
  const debts = await rows(db, `SELECT d.*, d.original_amount - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.debt_id=d.id AND t.type IN ('debt_payment','debt_collection') AND t.status='confirmed'),0) AS remaining
       FROM debts d WHERE d.user_id=$1 AND d.direction='owe' AND d.status='open' AND d.currency=$2 AND d.due_date IS NOT NULL AND d.due_date <= $3`, [userId, currency, horizon]);
  // Si una cuota recurrente ya cubre la deuda, no se cuenta dos veces.
  const linked = new Set((await rows(db, `SELECT debt_id FROM recurring WHERE user_id=$1 AND active AND debt_id IS NOT NULL`, [userId])).map((r) => r.debt_id));
  for (const d of debts) if (d.remaining > 0 && !linked.has(d.id)) out.push({ kind: 'debt', id: d.id, name: `Deuda: ${d.counterparty}`, date: d.due_date, amount: d.remaining, overdue: d.due_date < today });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function debtsWithRemaining(db: Db, userId: string) {
  return rows(db, `SELECT d.*, d.original_amount - COALESCE(p.s,0) AS remaining, COALESCE(p.n,0)::int AS payments_count
       FROM debts d LEFT JOIN (SELECT debt_id, SUM(amount) s, count(*) n FROM transactions WHERE user_id=$1 AND type IN ('debt_payment','debt_collection') AND status='confirmed' GROUP BY debt_id) p ON p.debt_id=d.id
      WHERE d.user_id=$1 ORDER BY d.status, d.due_date NULLS LAST, d.created_at`, [userId]);
}

export async function goalsWithProgress(db: Db, userId: string) {
  const gs = await rows(db, `SELECT g.*, COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.goal_id=g.id AND t.type='goal_saving' AND t.status='confirmed'),0) AS saved,
        (SELECT name FROM accounts a WHERE a.id=g.account_id) AS account_name,
        (SELECT min(occurred_at) FROM transactions t WHERE t.goal_id=g.id AND t.type='goal_saving' AND t.status='confirmed') AS first_saving
      FROM goals g WHERE g.user_id=$1 ORDER BY g.status, g.priority, g.target_date NULLS LAST`, [userId]);
  const now = Date.now();
  return gs.map((g) => {
    const pct = Math.min((g.saved / g.target_amount) * 100, 100);
    const missing = Math.max(g.target_amount - g.saved, 0);
    let weekly_needed: number | null = null, monthly_needed: number | null = null, eta: string | null = null, behind = false;
    if (g.target_date && missing > 0) {
      const daysLeft = (new Date(g.target_date + 'T23:59:59Z').getTime() - now) / 86400000;
      if (daysLeft > 0) { weekly_needed = Math.ceil(missing / Math.max(daysLeft / 7, 1)); monthly_needed = Math.ceil(missing / Math.max(daysLeft / 30.4375, 1)); }
      else behind = true;
    }
    // Estimación de cumplimiento por ritmo real (si hay historial) o por aportación periódica configurada.
    if (missing === 0) eta = 'cumplida';
    else if (g.first_saving && g.saved > 0) {
      const elapsedDays = Math.max((now - new Date(g.first_saving).getTime()) / 86400000, 7);
      const perDay = g.saved / elapsedDays;
      if (perDay > 0) eta = new Date(now + (missing / perDay) * 86400000).toISOString().slice(0, 10);
    } else if (g.contribution_amount) {
      const perDay = g.contribution_amount / (g.contribution_frequency === 'weekly' ? 7 : 30.4375);
      eta = new Date(now + (missing / perDay) * 86400000).toISOString().slice(0, 10);
    }
    if (eta && eta !== 'cumplida' && g.target_date && eta > g.target_date) behind = true;
    return { ...g, pct: Math.round(pct * 10) / 10, missing, weekly_needed, monthly_needed, eta_date: eta, behind, virtual: !g.account_id };
  });
}
