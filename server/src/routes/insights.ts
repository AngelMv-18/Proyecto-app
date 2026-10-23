import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, rows } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { idParam, parse, uid } from '../http.js';
import { askNova, aiStatus } from '../services/ai.js';
import { dashboard, evaluatePurchase } from '../services/insights.js';
import { refreshAlerts } from '../services/alerts.js';
import { REPORT_KINDS, buildReport, esc, reportToCsv, reportToHtml } from '../services/reports.js';
import { getUser, listTransactions } from '../services/stats.js';
import { toFilters } from './finance.js';

const uuid = z.string().uuid();

export async function insightRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    try { await refreshAlerts(pool, uid(req)); } catch { /* best-effort */ }
    return dashboard(pool, uid(req));
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
