import { Db, one, rows } from '../db.js';
import { Filters, LIQUID_TYPES, accountsWithBalances, categoryBreakdown, dailyBalance, debtsWithRemaining, getUser, incomeExpense, monthlySeries, whereFilters } from './stats.js';
import { baseline } from './insights.js';

export type Report = {
  kind: string; title: string; currency: string; params: Record<string, any>;
  columns: { key: string; label: string; type?: 'money' | 'text' | 'pct' | 'date' }[]; rows: Record<string, any>[]; totals?: Record<string, any>;
  quality: { level: 'real' | 'estimado' | 'incompleto'; notes: string[] };
};

export const REPORT_KINDS = ['income_statement', 'cash_flow', 'category_summary', 'balances', 'monthly_comparison', 'net_worth', 'debts', 'recurring', 'savings_rate', 'reconciliation'] as const;

async function quality(db: Db, userId: string, cur: string, f: Filters, tz: string): Promise<Report['quality']> {
  const notes: string[] = [];
  let level: Report['quality']['level'] = 'real';
  const params: any[] = [userId];
  const w = whereFilters({ from: f.from, to: f.to }, params);
  const pend = await one<{ n: number }>(db, `SELECT count(*)::int n FROM transactions t WHERE t.user_id=$1 AND t.status='pending' ${w}`, params);
  if (pend!.n) { level = 'incompleto'; notes.push(`${pend!.n} movimiento(s) pendientes de revisión no están incluidos.`); }
  const accs = await accountsWithBalances(db, userId);
  const foreign = accs.filter((a) => !a.archived && a.currency !== cur && a.balance_base == null);
  if (foreign.length) { level = 'incompleto'; notes.push(`${foreign.length} cuenta(s) en otra moneda sin tipo de cambio no se incluyen.`); }
  const conv = accs.filter((a) => !a.archived && a.currency !== cur && a.balance_base != null);
  if (conv.length) { if (level === 'real') level = 'estimado'; notes.push(`${conv.length} cuenta(s) en otra moneda se convierten con tu tipo de cambio manual en saldos y patrimonio; ingresos y gastos solo cuentan la moneda principal.`); }
  const unrec = accs.filter((a) => !a.archived && !a.last_reconciliation);
  if (unrec.length) notes.push(`${unrec.length} cuenta(s) nunca se han conciliado con el banco: los saldos son los calculados por la app.`);
  const b = await baseline(db, userId, cur, tz);
  if (!b.sufficient) { if (level === 'real') level = 'estimado'; notes.push(`Historial corto (${b.span_days} días): los promedios son estimaciones.`); }
  return { level, notes };
}

export async function buildReport(db: Db, userId: string, kind: string, f: Filters & { months?: number }): Promise<Report> {
  const u = await getUser(db, userId);
  const cur = u.currency, tz = u.timezone;
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text d`, [tz]))!.d;
  const monthStart = today.slice(0, 8) + '01';
  const fromDate = f.from ? f.from.slice(0, 10) : monthStart;
  const toDate = f.to ? f.to.slice(0, 10) : today;
  const filt: Filters = { ...f, from: f.from ?? (await one<{ s: Date }>(db, `SELECT ($1::date::timestamp) AT TIME ZONE $2 s`, [fromDate, tz]))!.s.toISOString(), to: f.to ?? (await one<{ s: Date }>(db, `SELECT (($1::date + 1)::timestamp) AT TIME ZONE $2 s`, [toDate, tz]))!.s.toISOString() };
  const q = await quality(db, userId, cur, filt, tz);
  const base = { currency: cur, params: { from: fromDate, to: toDate }, quality: q };

  switch (kind) {
    case 'income_statement': {
      const ie = await incomeExpense(db, userId, cur, filt);
      const p: any[] = [userId, cur]; const w = whereFilters(filt, p);
      const inc = await rows(db, `SELECT COALESCE(c.name,'Sin categoría') name, SUM(t.amount)::bigint total FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.type='income' AND t.debt_id IS NULL ${w} GROUP BY 1 ORDER BY 2 DESC`, p);
      const exp = await categoryBreakdown(db, userId, cur, filt);
      return { ...base, kind, title: 'Estado de ingresos y gastos', columns: [{ key: 'section', label: 'Sección' }, { key: 'name', label: 'Concepto' }, { key: 'total', label: 'Importe', type: 'money' }],
        rows: [...inc.map((r) => ({ section: 'Ingresos', name: r.name, total: r.total })), ...exp.map((r) => ({ section: 'Gastos (netos de devoluciones)', name: r.name, total: r.total }))],
        totals: { Ingresos: ie.income, Gastos: ie.expense, 'Resultado neto': ie.net, 'Aportes a metas': ie.goal_saved } };
    }
    case 'category_summary': {
      const cats = await categoryBreakdown(db, userId, cur, filt);
      const total = cats.reduce((s, c) => s + c.total, 0);
      return { ...base, kind, title: 'Resumen por categoría', columns: [{ key: 'name', label: 'Categoría' }, { key: 'nature', label: 'Naturaleza' }, { key: 'total', label: 'Gasto neto', type: 'money' }, { key: 'pct', label: '% del total', type: 'pct' }],
        rows: cats.map((c) => ({ name: c.name, nature: ({ essential: 'Esencial', discretionary: 'Discrecional', extraordinary: 'Extraordinario' } as any)[c.nature ?? 'discretionary'], total: c.total, pct: total ? Math.round((c.total / total) * 1000) / 10 : 0 })), totals: { Total: total } };
    }
    case 'cash_flow': {
      const p: any[] = [userId, cur, tz]; const w = whereFilters(filt, p);
      const r = await rows(db, `SELECT (t.occurred_at AT TIME ZONE $3)::date::text AS day,
          COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('income','debt_collection','refund')),0)::bigint AS inflow,
          COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('expense','debt_payment')),0)::bigint AS outflow
        FROM transactions t WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.type IN ('income','expense','debt_collection','debt_payment','refund') ${w} GROUP BY 1 ORDER BY 1`, p);
      let acc = 0;
      const out = r.map((x) => { acc += x.inflow - x.outflow; return { ...x, net: x.inflow - x.outflow, cumulative: acc }; });
      return { ...base, kind, title: 'Flujo de caja', columns: [{ key: 'day', label: 'Día', type: 'date' }, { key: 'inflow', label: 'Entradas', type: 'money' }, { key: 'outflow', label: 'Salidas', type: 'money' }, { key: 'net', label: 'Neto', type: 'money' }, { key: 'cumulative', label: 'Acumulado', type: 'money' }], rows: out,
        totals: { Entradas: out.reduce((s, x) => s + x.inflow, 0), Salidas: out.reduce((s, x) => s + x.outflow, 0), Neto: acc } };
    }
    case 'balances': {
      const s = await dailyBalance(db, userId, cur, tz, fromDate, toDate, f.account_id);
      return { ...base, kind, title: 'Evolución de saldos', columns: [{ key: 'day', label: 'Día', type: 'date' }, { key: 'balance', label: 'Saldo', type: 'money' }], rows: s, totals: s.length ? { Inicial: s[0].balance, Final: s[s.length - 1].balance } : {} };
    }
    case 'monthly_comparison': {
      const s = await monthlySeries(db, userId, cur, tz, f.months ?? 12);
      return { ...base, kind, title: 'Comparación mensual', columns: [{ key: 'month', label: 'Mes' }, { key: 'income', label: 'Ingresos', type: 'money' }, { key: 'expense', label: 'Gastos', type: 'money' }, { key: 'net', label: 'Ahorro neto', type: 'money' }], rows: s };
    }
    case 'savings_rate': {
      const s = await monthlySeries(db, userId, cur, tz, f.months ?? 12);
      return { ...base, kind, title: 'Tasa de ahorro', columns: [{ key: 'month', label: 'Mes' }, { key: 'income', label: 'Ingresos', type: 'money' }, { key: 'net', label: 'Ahorro neto', type: 'money' }, { key: 'rate', label: 'Tasa', type: 'pct' }], rows: s.map((m) => ({ ...m, rate: m.income > 0 ? Math.round((m.net / m.income) * 1000) / 10 : null })) };
    }
    case 'net_worth': {
      const accs = (await accountsWithBalances(db, userId)).filter((a) => !a.archived && !a.linked_account_id && a.balance_base != null);
      const debts = (await debtsWithRemaining(db, userId)).filter((d) => d.status === 'open' && d.currency === cur);
      const lines = [
        ...accs.map((a) => ({ group: a.type === 'credit_card' ? 'Pasivos: tarjetas' : 'Activos: cuentas', name: a.currency === cur ? a.name : `${a.name} (${a.currency} × ${a.fx_rate})`, total: a.balance_base })),
        ...debts.filter((d) => d.direction === 'owed').map((d) => ({ group: 'Activos: por cobrar', name: d.counterparty, total: d.remaining })),
        ...debts.filter((d) => d.direction === 'owe').map((d) => ({ group: 'Pasivos: por pagar', name: d.counterparty, total: -d.remaining })),
      ];
      return { ...base, quality: { level: q.level === 'real' ? 'estimado' : q.level, notes: [...q.notes, 'Patrimonio estimado: no incluye bienes (vivienda, vehículos) ni inversiones fuera de las cuentas registradas.'] }, kind, title: 'Patrimonio neto estimado',
        columns: [{ key: 'group', label: 'Grupo' }, { key: 'name', label: 'Concepto' }, { key: 'total', label: 'Importe', type: 'money' }], rows: lines, totals: { 'Patrimonio neto estimado': lines.reduce((s, l) => s + l.total, 0) } };
    }
    case 'debts': {
      const d = (await debtsWithRemaining(db, userId)).filter((x) => x.status === 'open');
      return { ...base, kind, title: 'Deudas pendientes', columns: [{ key: 'tipo', label: 'Tipo' }, { key: 'counterparty', label: 'Contraparte' }, { key: 'original_amount', label: 'Original', type: 'money' }, { key: 'remaining', label: 'Pendiente', type: 'money' }, { key: 'due_date', label: 'Vence', type: 'date' }],
        rows: d.map((x) => ({ ...x, tipo: x.direction === 'owe' ? 'Yo debo' : 'Me deben' })), totals: { 'Por pagar': d.filter((x) => x.direction === 'owe').reduce((s, x) => s + x.remaining, 0), 'Por cobrar': d.filter((x) => x.direction === 'owed').reduce((s, x) => s + x.remaining, 0) } };
    }
    case 'recurring': {
      const r = await rows(db, `SELECT name, kind, amount, frequency, next_date::text, active FROM recurring WHERE user_id=$1 ORDER BY active DESC, next_date`, [userId]);
      const mult: any = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12 };
      const monthly = r.filter((x) => x.active).reduce((s, x) => s + x.amount * mult[x.frequency], 0);
      return { ...base, quality: { level: 'estimado', notes: [...q.notes, 'El equivalente mensual es una estimación sobre importes esperados.'] }, kind, title: 'Gastos recurrentes', columns: [{ key: 'name', label: 'Concepto' }, { key: 'frequency', label: 'Frecuencia' }, { key: 'amount', label: 'Importe', type: 'money' }, { key: 'next_date', label: 'Próximo', type: 'date' }], rows: r, totals: { 'Equivalente mensual': Math.round(monthly) } };
    }
    case 'reconciliation': {
      const accs = (await accountsWithBalances(db, userId)).filter((a) => !a.archived && !a.linked_account_id);
      return { ...base, kind, title: 'Registrado vs. conciliado', columns: [{ key: 'name', label: 'Cuenta' }, { key: 'balance', label: 'Saldo en la app', type: 'money' }, { key: 'bank', label: 'Último saldo del banco', type: 'money' }, { key: 'as_of', label: 'Fecha', type: 'date' }, { key: 'diff', label: 'Diferencia al cierre', type: 'money' }],
        rows: accs.map((a) => ({ name: a.name, balance: a.balance, bank: a.last_reconciliation?.bank_balance ?? null, as_of: a.last_reconciliation?.as_of ?? null, diff: a.last_reconciliation?.difference ?? null })) };
    }
  }
  throw new Error('Informe desconocido');
}

// Texto: se neutraliza la inyección de fórmulas (=, +, -, @) al abrir en hojas de cálculo.
export const esc = (v: any) => { const s = v == null ? '' : String(v); const g = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return /[",\n\r;]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
const money = (v: number | null) => (v == null ? '' : (v / 100).toFixed(2));

export function reportToCsv(r: Report): string {
  const lines = [r.columns.map((c) => esc(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => (c.type === 'money' ? money(row[c.key]) : esc(row[c.key]))).join(','));
  if (r.totals) for (const [k, v] of Object.entries(r.totals)) lines.push([esc(k), money(v as number)].join(','));
  lines.push('', esc(`Calidad de datos: ${r.quality.level}`), ...r.quality.notes.map(esc));
  return '﻿' + lines.join('\r\n');
}

export function reportToHtml(r: Report, locale = 'es-HN'): string {
  const fm = (v: number | null) => (v == null ? '—' : new Intl.NumberFormat(locale, { style: 'currency', currency: r.currency, currencyDisplay: 'code' }).format(v / 100));
  const h = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const cell = (c: Report['columns'][number], v: any) => (c.type === 'money' ? `<td class="n">${fm(v)}</td>` : c.type === 'pct' ? `<td class="n">${v == null ? '—' : v + ' %'}</td>` : `<td>${h(v)}</td>`);
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${h(r.title)} · NOVA FINANCE</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#111}h1{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f4f4f4}td.n{text-align:right;font-variant-numeric:tabular-nums}.q{margin-top:16px;padding:10px;border:1px solid #bbb;border-radius:6px}.t{margin-top:12px;font-weight:600}@media print{button{display:none}}</style>
<button onclick="print()">Imprimir / guardar PDF</button><h1>${h(r.title)}</h1><div>NOVA FINANCE · ${h(r.params.from)} → ${h(r.params.to)} · ${h(r.currency)}</div>
<table><thead><tr>${r.columns.map((c) => `<th>${h(c.label)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${r.columns.map((c) => cell(c, row[c.key])).join('')}</tr>`).join('')}</tbody></table>
${r.totals ? Object.entries(r.totals).map(([k, v]) => `<div class="t">${h(k)}: ${fm(v as number)}</div>`).join('') : ''}
<div class="q"><b>Calidad de los datos: ${h(r.quality.level)}</b><ul>${r.quality.notes.map((n) => `<li>${h(n)}</li>`).join('')}</ul></div></html>`;
}
