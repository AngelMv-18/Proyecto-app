import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, rows } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { idParam, parse, uid } from '../http.js';
import { askNova, aiStatus } from '../services/ai.js';
import { dashboard, evaluatePurchase } from '../services/insights.js';
import { refreshAlerts } from '../services/alerts.js';
import { REPORT_KINDS, buildReport, esc, reportToCsv, reportToHtml } from '../services/reports.js';
import { budgetsStatus, categoryBreakdown, dailyBalance, getUser, incomeExpense, listTransactions, monthlySeries, natureBreakdown, periodBounds } from '../services/stats.js';
import { toFilters } from './finance.js';

const uuid = z.string().uuid();

export async function insightRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    try { await refreshAlerts(pool, uid(req)); } catch { /* best-effort */ }
    return dashboard(pool, uid(req));
  });

  // ---------- Análisis filtrable (fechas, cuenta, categoría, método de pago) ----------
  app.get('/api/analysis', async (req) => {
    const q = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), account_id: uuid.optional(), category_id: uuid.optional(), payment_method: z.string().max(40).optional() }), req.query);
    const u = await getUser(pool, uid(req));
    const cur = u.currency;
    const month = await periodBounds(pool, u.timezone, 'month');
    const f = { ...q, from: q.from ?? month.start, to: q.to ?? month.end };
    const [summary, categories, monthly] = await Promise.all([incomeExpense(pool, uid(req), cur, f), categoryBreakdown(pool, uid(req), cur, f), monthlySeries(pool, uid(req), cur, u.timezone, 6)]);
    const extraFor = (params: any[]) => {
      let extra = '';
      if (q.account_id) { params.push(q.account_id); extra += ` AND t.account_id=$${params.length}`; }
      if (q.category_id) { params.push(q.category_id); extra += ` AND (t.category_id=$${params.length} OR t.category_id IN (SELECT id FROM categories WHERE parent_id=$${params.length}))`; }
      if (q.payment_method) { params.push(q.payment_method); extra += ` AND t.payment_method=$${params.length}`; }
      return extra;
    };
    const dp: any[] = [uid(req), cur, u.timezone, f.from, f.to];
    const daily = await rows(pool, `SELECT (t.occurred_at AT TIME ZONE $3)::date::text AS day,
        (COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.debt_id IS NULL),0) - COALESCE(SUM(t.amount) FILTER (WHERE t.type='refund'),0))::bigint AS expense,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.debt_id IS NULL),0)::bigint AS income
      FROM transactions t WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.occurred_at >= $4 AND t.occurred_at < $5 ${extraFor(dp)} GROUP BY 1 ORDER BY 1`, dp);
    const wp: any[] = [uid(req), cur, u.timezone];
    const weekly = await rows(pool, `SELECT to_char(date_trunc('week', t.occurred_at AT TIME ZONE $3),'YYYY-MM-DD') AS week,
        (COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.debt_id IS NULL),0) - COALESCE(SUM(t.amount) FILTER (WHERE t.type='refund'),0))::bigint AS expense
      FROM transactions t WHERE t.user_id=$1 AND t.status='confirmed' AND t.currency=$2 AND t.occurred_at >= now() - interval '8 weeks' ${extraFor(wp)} GROUP BY 1 ORDER BY 1`, wp);
    const methods = await rows(pool, `SELECT DISTINCT payment_method FROM transactions WHERE user_id=$1 AND payment_method IS NOT NULL ORDER BY 1`, [uid(req)]);
    const fromDay = (await pool.query(`SELECT ($1::timestamptz AT TIME ZONE $2)::date::text d`, [f.from, u.timezone])).rows[0].d;
    const toDay = (await pool.query(`SELECT (($1::timestamptz - interval '1 second') AT TIME ZONE $2)::date::text d`, [f.to, u.timezone])).rows[0].d;
    const balance = fromDay <= toDay ? await dailyBalance(pool, uid(req), cur, u.timezone, fromDay, toDay, q.account_id) : [];
    return { currency: cur, period: { from: f.from, to: f.to }, summary, categories, daily, weekly, monthly, balance, payment_methods: methods.map((m: any) => m.payment_method) };
  });

  app.get('/api/budgets/insights', async (req) => {
    const u = await getUser(pool, uid(req));
    const cur = u.currency;
    const a = await periodBounds(pool, u.timezone, 'month'), b = await periodBounds(pool, u.timezone, 'month', -1);
    const elapsed = Math.max((Date.now() - new Date(a.start).getTime()) / (new Date(a.end).getTime() - new Date(a.start).getTime()), 0.05);
    const [nature, ca, cb, budgets] = await Promise.all([natureBreakdown(pool, uid(req), cur, { from: a.start, to: a.end }), categoryBreakdown(pool, uid(req), cur, { from: a.start, to: a.end }), categoryBreakdown(pool, uid(req), cur, { from: b.start, to: b.end }), budgetsStatus(pool, uid(req), cur, u.timezone)]);
    // Comparar contra el mes anterior al mismo punto del mes (ritmo proyectado), no contra el mes completo.
    const increases = ca.map((c) => ({ category: c.name, current: c.total, projected: Math.round(c.total / elapsed), previous: cb.find((x) => x.name === c.name)?.total ?? 0 }))
      .filter((c) => c.previous > 0 && c.projected > c.previous * 1.3 && c.projected - c.previous > 5000);
    const recommendations: string[] = [];
    for (const x of budgets.filter((x) => x.period === 'monthly' && x.projected > x.amount)) recommendations.push(`${x.category_name}: al ritmo actual terminarías el mes en ${Math.round(x.projected / 100)} ${cur} (límite ${Math.round(x.amount / 100)}). Reduce ~${Math.round((x.projected - x.amount) / 100)} ${cur} o ajusta el límite.`);
    for (const i of increases) recommendations.push(`${i.category}: ritmo proyectado ${Math.round(((i.projected / i.previous) - 1) * 100)}% mayor que el mes anterior.`);
    const slack = budgets.filter((x) => x.period === 'monthly' && x.pct < 40 && elapsed > 0.6);
    for (const x of slack) recommendations.push(`${x.category_name} lleva solo ${x.pct}% con ${Math.round(elapsed * 100)}% del mes: podrías mover presupuesto a otra categoría.`);
    return { elapsed: Math.round(elapsed * 100), nature, increases, recommendations };
  });

  // ---------- Notificaciones ----------
  app.get('/api/notifications', async (req) => {
    const q = parse(z.object({ unread: z.enum(['true', 'false']).optional() }), req.query);
    return rows(pool, `SELECT * FROM notifications WHERE user_id=$1 ${q.unread === 'true' ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`, [uid(req)]);
  });
  app.post('/api/notifications/:id/read', async (req) => {
    const { id } = parse(idParam, req.params);
    await pool.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [id, uid(req)]);
    return { ok: true };
  });
  app.post('/api/notifications/read-all', async (req) => { await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [uid(req)]); return { ok: true }; });

  // ---------- Compras e IA ----------
  app.post('/api/purchase/evaluate', async (req) => {
    const b = parse(z.object({
      item: z.string().trim().min(1).max(120), price: z.number().int().positive(), payment: z.enum(['cash', 'debit', 'credit', 'installments']), installments: z.number().int().min(1).max(60).optional(),
      installments_total: z.number().int().positive().optional(), kind: z.enum(['need', 'want']), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), extra_costs: z.number().int().min(0).default(0),
      category_id: uuid.nullish(), goal_id: uuid.nullish(),
    }), req.body);
    return evaluatePurchase(pool, uid(req), b);
  });
  app.get('/api/ai/status', async () => aiStatus());
  app.post('/api/ai/chat', async (req) => {
    const b = parse(z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) })).min(1).max(20) }), req.body);
    return askNova(pool, uid(req), b.messages);
  });

  // ---------- Informes ----------
  app.get('/api/reports/:kind', async (req, reply) => {
    const { kind } = parse(z.object({ kind: z.enum(REPORT_KINDS) }), req.params);
    const q = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), account_id: uuid.optional(), category_id: uuid.optional(), format: z.enum(['json', 'csv', 'html']).default('json'), months: z.coerce.number().int().min(1).max(36).optional() }), req.query);
    const r = await buildReport(pool, uid(req), kind, q);
    if (q.format === 'csv') { reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="nova-${kind}.csv"`); return reportToCsv(r); }
    if (q.format === 'html') { reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"); return reportToHtml(r); }
    return r;
  });
  app.get('/api/export/transactions.csv', async (req, reply) => {
    const q = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), account_id: uuid.optional(), category_id: uuid.optional(), status: z.enum(['pending', 'confirmed', 'void']).optional(), type: z.string().optional(), q: z.string().max(100).optional() }), req.query);
    const r = await listTransactions(pool, uid(req), q, 100000, 0);
    const head = ['id', 'fecha', 'tipo', 'estado', 'origen', 'importe', 'moneda', 'cuenta', 'cuenta_destino', 'categoria', 'comercio', 'metodo_pago', 'descripcion', 'etiquetas'];
    const lines = [head.join(',')];
    for (const t of r.items) lines.push([t.id, t.occurred_at.toISOString(), t.type, t.status, t.source, (t.amount / 100).toFixed(2), t.currency, esc(t.account_name), esc(t.to_account_name), esc(t.category_name), esc(t.merchant), esc(t.payment_method), esc(t.description), esc((t.tags ?? []).join('|'))].join(','));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="nova-movimientos.csv"');
    return '﻿' + lines.join('\r\n');
  });

  // ---------- Búsqueda global y auditoría ----------
  app.get('/api/search', async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(60) }), req.query);
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const id = uid(req);
    const [tx, accounts, goals, debts, recurring, categories] = await Promise.all([
      rows(pool, `SELECT id, type, amount, currency, merchant, description, occurred_at, status FROM transactions WHERE user_id=$1 AND (merchant ILIKE $2 OR description ILIKE $2 OR $3 = ANY(tags)) ORDER BY occurred_at DESC LIMIT 8`, [id, like, q]),
      rows(pool, `SELECT id, name, type FROM accounts WHERE user_id=$1 AND name ILIKE $2 LIMIT 5`, [id, like]),
      rows(pool, `SELECT id, name FROM goals WHERE user_id=$1 AND name ILIKE $2 LIMIT 5`, [id, like]),
      rows(pool, `SELECT id, counterparty AS name, direction FROM debts WHERE user_id=$1 AND counterparty ILIKE $2 LIMIT 5`, [id, like]),
      rows(pool, `SELECT id, name FROM recurring WHERE user_id=$1 AND name ILIKE $2 LIMIT 5`, [id, like]),
      rows(pool, `SELECT id, name FROM categories WHERE user_id=$1 AND name ILIKE $2 LIMIT 5`, [id, like]),
    ]);
    return { transactions: tx, accounts, goals, debts, recurring, categories };
  });
  app.get('/api/audit', async (req) => {
    const q = parse(z.object({ entity: z.string().max(30).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return rows(pool, `SELECT id, entity, entity_id, action, detail, created_at FROM audit_log WHERE user_id=$1 ${q.entity ? 'AND entity=$3' : ''} ORDER BY id DESC LIMIT $2`, q.entity ? [uid(req), q.limit, q.entity] : [uid(req), q.limit]);
  });
}
