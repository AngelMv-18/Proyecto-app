import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, rows, withTx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import { idParam, parse, uid } from '../http.js';
import { accountBalance, confirmTransaction, createTransaction, discardPending, getTx, txInputSchema, txPatchSchema, updateTransaction, voidTransaction } from '../services/ledger.js';
import { Filters, accountsWithBalances, budgetsStatus, debtsWithRemaining, getUser, goalsWithProgress, listTransactions, nextOccurrence, periodBounds, upcomingObligations } from '../services/stats.js';
import { refreshAlerts } from '../services/alerts.js';
import { suggestRecurring } from '../services/insights.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const uuid = z.string().uuid();

/** Ejecuta una mutación atómica y después refresca las alertas (best-effort, fuera de la transacción). */
async function mutate<T>(userId: string, fn: (c: any) => Promise<T>): Promise<T> {
  const r = await withTx(fn);
  try { await refreshAlerts(pool, userId); } catch { /* las alertas nunca deben romper una operación contable */ }
  return r;
}

async function syncDebt(c: any, debtId?: string | null) {
  if (!debtId) return;
  await c.query(`UPDATE debts d SET status = CASE WHEN d.original_amount - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.debt_id=d.id AND t.type IN ('debt_payment','debt_collection') AND t.status='confirmed'),0) <= 0 THEN 'closed' ELSE 'open' END WHERE d.id=$1`, [debtId]);
}

const filtersSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  account_id: uuid.optional(), category_id: uuid.optional(), payment_method: z.string().max(40).optional(),
  type: z.string().max(20).optional(), status: z.enum(['pending', 'confirmed', 'void']).optional(), q: z.string().max(100).optional(),
  tag: z.string().max(30).optional(), source: z.string().max(20).optional(), needs_review: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
});
export const toFilters = (q: z.infer<typeof filtersSchema>): Filters => ({ ...q, needs_review: q.needs_review === 'true' });

// Apariencia tipo billetera. Solo últimos 4 dígitos: el número completo nunca se acepta.
const appearance = {
  bank_code: z.string().regex(/^[a-z0-9_]{2,30}$/).nullish(),
  card_network: z.enum(['visa', 'mastercard', 'amex', 'unionpay', 'none']).nullish(),
  last4: z.string().regex(/^[0-9]{4}$/, 'Solo los últimos 4 dígitos').nullish(),
  card_colors: z.string().regex(/^#[0-9A-Fa-f]{6}(,#[0-9A-Fa-f]{6}){0,2}$/).nullish(),
};

export async function financeRoutes(app: FastifyInstance) {
  // ---------- Cuentas ----------
  app.get('/api/accounts', async (req) => accountsWithBalances(pool, uid(req)));

  app.post('/api/accounts', async (req) => {
    const b = parse(z.object({
      name: z.string().trim().min(1).max(60), type: z.enum(['cash', 'bank', 'debit_card', 'credit_card', 'wallet', 'savings', 'other']),
      currency: z.string().length(3).toUpperCase().optional(), opening_balance: z.number().int().safe().default(0), opening_date: isoDate.optional(),
      credit_limit: z.number().int().min(0).nullish(), color: z.string().max(20).nullish(), ...appearance,
    }), req.body);
    const u = await getUser(pool, uid(req));
    return mutate(uid(req), async (c) => {
      try {
        const a = await one(c, `INSERT INTO accounts(user_id,name,type,currency,opening_balance,opening_date,credit_limit,color,bank_code,card_network,last4,card_colors,sort_order)
            VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,(now() AT TIME ZONE $9)::date),$7,$8,$10,$11,$12,$13,(SELECT COALESCE(max(sort_order),0)+1 FROM accounts WHERE user_id=$1)) RETURNING *`,
          [uid(req), b.name, b.type, b.currency ?? u.currency, b.opening_balance, b.opening_date ?? null, b.type === 'credit_card' ? b.credit_limit ?? null : null, b.color ?? null, u.timezone, b.bank_code ?? null, b.card_network ?? null, b.last4 ?? null, b.card_colors ?? null]);
        await audit(c, uid(req), 'account', a.id, 'create', null, a);
        return a;
      } catch (e: any) { if (e.code === '23505') throw conflict('Ya tienes una cuenta con ese nombre', 'duplicate_name'); throw e; }
    });
  });

  app.patch('/api/accounts/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), archived: z.boolean(), credit_limit: z.number().int().min(0).nullable(), color: z.string().max(20).nullable(), opening_balance: z.number().int().safe(), opening_date: isoDate, ...appearance, sort_order: z.number().int().min(0).max(10000) }).partial(), req.body);
    return mutate(uid(req), async (c) => {
      const before = await one(c, 'SELECT * FROM accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, uid(req)]);
      if (!before) throw notFound('Cuenta');
      if (b.opening_date) {
        const u = await getUser(c, uid(req));
        const early = await one(c, `SELECT 1 FROM transactions WHERE (account_id=$1 OR to_account_id=$1) AND status<>'void' AND (occurred_at AT TIME ZONE $3)::date < $2::date LIMIT 1`, [id, b.opening_date, u.timezone]);
        if (early) throw badRequest('Hay movimientos anteriores a esa fecha de saldo inicial', 'before_opening');
      }
      try {
        const m = { ...before, ...b };
        const a = await one(c, `UPDATE accounts SET name=COALESCE($3,name), archived=COALESCE($4,archived), credit_limit=CASE WHEN $5 THEN $6 ELSE credit_limit END, color=COALESCE($7,color), opening_balance=COALESCE($8,opening_balance), opening_date=COALESCE($9::date,opening_date),
              bank_code=$10, card_network=$11, last4=$12, card_colors=$13, sort_order=$14 WHERE id=$1 AND user_id=$2 RETURNING *`,
          [id, uid(req), b.name ?? null, b.archived ?? null, 'credit_limit' in b, b.credit_limit ?? null, b.color ?? null, b.opening_balance ?? null, b.opening_date ?? null, m.bank_code ?? null, m.card_network ?? null, m.last4 ?? null, m.card_colors ?? null, m.sort_order ?? 0]);
        await audit(c, uid(req), 'account', id, 'update', before, a);
        return a;
      } catch (e: any) { if (e.code === '23505') throw conflict('Ya tienes una cuenta con ese nombre', 'duplicate_name'); throw e; }
    });
  });

  app.post('/api/accounts/:id/reconcile', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ bank_balance: z.number().int().safe(), as_of: isoDate, note: z.string().max(300).optional(), create_adjustment: z.boolean().default(false) }), req.body);
    const u = await getUser(pool, uid(req));
    return mutate(uid(req), async (c) => {
      const a = await one(c, 'SELECT * FROM accounts WHERE id=$1 AND user_id=$2', [id, uid(req)]);
      if (!a) throw notFound('Cuenta');
      const end = (await one<{ e: Date }>(c, `SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) e`, [b.as_of, u.timezone]))!.e.toISOString();
      const app_balance = await accountBalance(c, id, end);
      const difference = b.bank_balance - app_balance;
      let adj: string | null = null;
      if (b.create_adjustment && difference !== 0) {
        const when = (await one<{ t: Date }>(c, `SELECT (($1::date)::timestamp + interval '23 hours 59 minutes') AT TIME ZONE $2 t`, [b.as_of, u.timezone]))!.t.toISOString();
        const r = await createTransaction(c, uid(req), { type: 'adjustment', amount: difference, account_id: id, occurred_at: when, description: `Ajuste por conciliación al ${b.as_of}`, merchant: 'Conciliación' });
        adj = r.tx.id;
      }
      const rec = await one(c, `INSERT INTO reconciliations(user_id,account_id,as_of,bank_balance,app_balance,difference,adjustment_tx,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [uid(req), id, b.as_of, b.bank_balance, app_balance, difference, adj, b.note ?? null]);
      await audit(c, uid(req), 'account', id, 'reconcile', null, rec);
      return rec;
    });
  });
  app.get('/api/accounts/:id/reconciliations', async (req) => {
    const { id } = parse(idParam, req.params);
    return rows(pool, 'SELECT * FROM reconciliations WHERE account_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50', [id, uid(req)]);
  });

  // Detalle de una cuenta/tarjeta: fondos, pagos agendados con ella y últimos movimientos.
  app.get('/api/accounts/:id/overview', async (req) => {
    const { id } = parse(idParam, req.params);
    const u = await getUser(pool, uid(req));
    const acc = (await accountsWithBalances(pool, uid(req))).find((a) => a.id === id);
    if (!acc) throw notFound('Cuenta');
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }), req.query);
    const upcoming = (await upcomingObligations(pool, uid(req), acc.currency, u.timezone, q.days)).filter((o) => o.account_id === id);
    const upcomingTotal = upcoming.reduce((s, o) => s + o.amount, 0);
    const month = await periodBounds(pool, u.timezone, 'month');
    const spent = await one<{ s: number }>(pool, `SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount WHEN type='refund' THEN -amount ELSE 0 END),0)::bigint s FROM transactions WHERE user_id=$1 AND account_id=$2 AND status='confirmed' AND debt_id IS NULL AND occurred_at >= $3 AND occurred_at < $4`, [uid(req), id, month.start, month.end]);
    const recent = await listTransactions(pool, uid(req), { account_id: id }, 8);
    // Para tarjetas de crédito, lo "disponible" es el crédito; para el resto, el saldo libre de reservas.
    const available = acc.type === 'credit_card' ? acc.available_credit : acc.balance - acc.reserved_virtual;
    return {
      account: acc, days: q.days, upcoming, upcoming_total: upcomingTotal,
      after_upcoming: available == null ? null : available - upcomingTotal,
      month_spent: spent!.s, recent: recent.items, recent_total: recent.total,
    };
  });

  // ---------- Tipos de cambio manuales ----------
  app.get('/api/fx', async (req) => rows(pool, 'SELECT currency, rate, updated_at FROM fx_rates WHERE user_id=$1 ORDER BY currency', [uid(req)]));
  app.put('/api/fx', async (req) => {
    const b = parse(z.object({ currency: z.string().length(3).toUpperCase(), rate: z.number().positive().max(1e9) }), req.body);
    const u = await getUser(pool, uid(req));
    if (b.currency === u.currency) throw badRequest('Esa es tu moneda principal');
    const r = await one(pool, `INSERT INTO fx_rates(user_id,currency,rate) VALUES ($1,$2,$3) ON CONFLICT (user_id,currency) DO UPDATE SET rate=$3, updated_at=now() RETURNING currency, rate, updated_at`, [uid(req), b.currency, b.rate]);
    await audit(pool, uid(req), 'fx_rate', b.currency, 'upsert', null, r);
    return r;
  });
  app.delete('/api/fx/:currency', async (req) => {
    const { currency } = parse(z.object({ currency: z.string().length(3).toUpperCase() }), req.params);
    await pool.query('DELETE FROM fx_rates WHERE user_id=$1 AND currency=$2', [uid(req), currency]);
    await audit(pool, uid(req), 'fx_rate', currency, 'delete');
    return { ok: true };
  });

  // ---------- Categorías ----------
  app.get('/api/categories', async (req) => rows(pool, 'SELECT * FROM categories WHERE user_id=$1 ORDER BY kind, parent_id NULLS FIRST, name', [uid(req)]));
  app.post('/api/categories', async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), parent_id: uuid.nullish(), nature: z.enum(['essential', 'discretionary', 'extraordinary']).default('discretionary'), kind: z.enum(['expense', 'income']).default('expense'), icon: z.string().max(30).nullish() }), req.body);
    if (b.parent_id && !(await one(pool, 'SELECT 1 FROM categories WHERE id=$1 AND user_id=$2 AND parent_id IS NULL', [b.parent_id, uid(req)]))) throw badRequest('Categoría padre no válida');
    try {
      return await one(pool, 'INSERT INTO categories(user_id,name,parent_id,nature,kind,icon) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [uid(req), b.name, b.parent_id ?? null, b.nature, b.kind, b.icon ?? null]);
    } catch (e: any) { if (e.code === '23505') throw conflict('Esa categoría ya existe'); throw e; }
  });
  app.patch('/api/categories/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), nature: z.enum(['essential', 'discretionary', 'extraordinary']), archived: z.boolean() }).partial(), req.body);
    const r = await one(pool, 'UPDATE categories SET name=COALESCE($3,name), nature=COALESCE($4,nature), archived=COALESCE($5,archived) WHERE id=$1 AND user_id=$2 RETURNING *', [id, uid(req), b.name ?? null, b.nature ?? null, b.archived ?? null]);
    if (!r) throw notFound('Categoría');
    return r;
  });
  app.delete('/api/categories/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const used = await one(pool, 'SELECT 1 FROM transactions WHERE category_id=$1 AND user_id=$2 LIMIT 1', [id, uid(req)]);
    if (used) throw conflict('La categoría tiene movimientos: archívala en lugar de eliminarla', 'category_in_use');
    const r = await pool.query('DELETE FROM categories WHERE id=$1 AND user_id=$2', [id, uid(req)]);
    if (!r.rowCount) throw notFound('Categoría');
    return { ok: true };
  });

  // ---------- Movimientos ----------
  app.get('/api/transactions', async (req) => {
    const q = parse(filtersSchema, req.query);
    return listTransactions(pool, uid(req), toFilters(q), q.limit, q.offset);
  });
  app.get('/api/transactions/review', async (req) => listTransactions(pool, uid(req), { needs_review: true, status: 'pending' }, 100));
  app.post('/api/transactions', async (req, reply) => {
    const b = parse(txInputSchema, req.body);
    const res = await mutate(uid(req), async (c) => {
      const r = await createTransaction(c, uid(req), b);
      if (!r.duplicate) await syncDebt(c, r.tx.debt_id);
      return r;
    });
    reply.code(res.duplicate ? 200 : 201);
    return res;
  });
  app.get('/api/transactions/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await getTx(pool, uid(req), id);
    const history = await rows(pool, `SELECT id, action, before, after, detail, created_at FROM audit_log WHERE user_id=$1 AND entity='transaction' AND entity_id=$2 ORDER BY id`, [uid(req), id]);
    return { ...t, history };
  });
  app.patch('/api/transactions/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(txPatchSchema, req.body);
    return mutate(uid(req), async (c) => { const before = await getTx(c, uid(req), id); const t = await updateTransaction(c, uid(req), id, b); await syncDebt(c, before.debt_id); await syncDebt(c, t.debt_id); return t; });
  });
  app.post('/api/transactions/:id/void', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica un motivo').max(300) }), req.body);
    return mutate(uid(req), async (c) => { const t = await voidTransaction(c, uid(req), id, b.reason); await syncDebt(c, t.debt_id); return t; });
  });
  app.post('/api/transactions/:id/confirm', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ patch: txPatchSchema.optional() }), req.body);
    return mutate(uid(req), async (c) => { const t = await confirmTransaction(c, uid(req), id, b.patch); await syncDebt(c, t.debt_id); return t; });
  });
  app.post('/api/transactions/review/confirm-all', async (req) => {
    const b = parse(z.object({ ids: z.array(uuid).min(1).max(200) }), req.body);
    return mutate(uid(req), async (c) => {
      const done: string[] = [], failed: { id: string; error: string }[] = [];
      for (const id of b.ids) {
        await c.query('SAVEPOINT s');
        try { const t = await confirmTransaction(c, uid(req), id); await syncDebt(c, t.debt_id); done.push(id); await c.query('RELEASE SAVEPOINT s'); }
        catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT s'); failed.push({ id, error: e.message }); }
      }
      return { confirmed: done, failed };
    });
  });
  app.delete('/api/transactions/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ reason: z.string().max(300).optional() }), req.query);
    return mutate(uid(req), (c) => discardPending(c, uid(req), id, q.reason));
  });

  // Comprobantes (imagen/PDF ≤ 3 MB)
  app.put('/api/transactions/:id/receipt', async (req) => {
    const { id } = parse(idParam, req.params);
    const mime = String(req.headers['content-type']).split(';')[0];
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Archivo vacío');
    await getTx(pool, uid(req), id);
    await withTx(async (c) => {
      await c.query(`INSERT INTO receipts(transaction_id,user_id,mime,data) VALUES ($1,$2,$3,$4) ON CONFLICT (transaction_id) DO UPDATE SET mime=$3, data=$4`, [id, uid(req), mime, req.body]);
      await c.query('UPDATE transactions SET has_receipt=true WHERE id=$1', [id]);
      await audit(c, uid(req), 'transaction', id, 'receipt_attached');
    });
    return { ok: true };
  });
  app.get('/api/transactions/:id/receipt', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, 'SELECT mime,data FROM receipts WHERE transaction_id=$1 AND user_id=$2', [id, uid(req)]);
    if (!r) throw notFound('Comprobante');
    reply.header('content-type', r.mime).header('content-disposition', 'inline').header('x-content-type-options', 'nosniff');
    return reply.send(r.data);
  });

  // ---------- Presupuestos ----------
  app.get('/api/budgets', async (req) => { const u = await getUser(pool, uid(req)); return budgetsStatus(pool, uid(req), u.currency, u.timezone); });
  app.put('/api/budgets', async (req) => {
    const b = parse(z.object({ category_id: uuid, period: z.enum(['monthly', 'weekly']), amount: z.number().int().positive() }), req.body);
    if (!(await one(pool, 'SELECT 1 FROM categories WHERE id=$1 AND user_id=$2', [b.category_id, uid(req)]))) throw badRequest('Categoría no válida');
    return mutate(uid(req), async (c) => {
      const r = await one(c, `INSERT INTO budgets(user_id,category_id,period,amount) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,category_id,period) DO UPDATE SET amount=$4 RETURNING *`, [uid(req), b.category_id, b.period, b.amount]);
      await audit(c, uid(req), 'budget', r.id, 'upsert', null, r);
      return r;
    });
  });
  app.delete('/api/budgets/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await pool.query('DELETE FROM budgets WHERE id=$1 AND user_id=$2 RETURNING id', [id, uid(req)]);
    if (!r.rowCount) throw notFound('Presupuesto');
    await audit(pool, uid(req), 'budget', id, 'delete');
    return { ok: true };
  });
  app.post('/api/budgets/transfer', async (req) => {
    const b = parse(z.object({ from_id: uuid, to_id: uuid, amount: z.number().int().positive() }), req.body);
    if (b.from_id === b.to_id) throw badRequest('Elige presupuestos distintos');
    return mutate(uid(req), async (c) => {
      const f = await one(c, 'SELECT * FROM budgets WHERE id=$1 AND user_id=$2 FOR UPDATE', [b.from_id, uid(req)]);
      const t = await one(c, 'SELECT * FROM budgets WHERE id=$1 AND user_id=$2 FOR UPDATE', [b.to_id, uid(req)]);
      if (!f || !t) throw notFound('Presupuesto');
      if (f.period !== t.period) throw badRequest('Los presupuestos deben tener el mismo período');
      if (b.amount >= f.amount) throw badRequest('El presupuesto de origen debe conservar un importe mayor que cero', 'validation', { amount: 'Excede lo disponible en el presupuesto de origen' });
      await c.query('UPDATE budgets SET amount=amount-$2 WHERE id=$1', [f.id, b.amount]);
      await c.query('UPDATE budgets SET amount=amount+$2 WHERE id=$1', [t.id, b.amount]);
      await audit(c, uid(req), 'budget', f.id, 'transfer', { from: f.amount, to: t.amount }, { from: f.amount - b.amount, to: t.amount + b.amount }, `Transferencia de presupuesto ${b.amount}`);
      return { ok: true };
    });
  });

  // ---------- Metas ----------
  const goalBody = z.object({
    name: z.string().trim().min(1).max(80), target_amount: z.number().int().positive(), target_date: isoDate.nullish(), priority: z.number().int().min(1).max(3).default(2),
    contribution_amount: z.number().int().positive().nullish(), contribution_frequency: z.enum(['weekly', 'monthly']).nullish(), account_id: uuid.nullish(),
  });
  app.get('/api/goals', async (req) => goalsWithProgress(pool, uid(req)));
  app.post('/api/goals', async (req) => {
    const b = parse(goalBody, req.body);
    if (b.account_id && !(await one(pool, 'SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2', [b.account_id, uid(req)]))) throw badRequest('Cuenta no válida');
    return mutate(uid(req), async (c) => {
      const g = await one(c, `INSERT INTO goals(user_id,name,target_amount,target_date,priority,contribution_amount,contribution_frequency,account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [uid(req), b.name, b.target_amount, b.target_date ?? null, b.priority, b.contribution_amount ?? null, b.contribution_frequency ?? null, b.account_id ?? null]);
      await audit(c, uid(req), 'goal', g.id, 'create', null, g);
      return g;
    });
  });
  app.patch('/api/goals/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(goalBody.partial().extend({ status: z.enum(['active', 'done', 'archived']).optional() }), req.body);
    return mutate(uid(req), async (c) => {
      const before = await one(c, 'SELECT * FROM goals WHERE id=$1 AND user_id=$2', [id, uid(req)]);
      if (!before) throw notFound('Meta');
      if ('account_id' in b && b.account_id !== before.account_id) {
        const saved = await one<{ n: number }>(c, `SELECT count(*)::int n FROM transactions WHERE goal_id=$1 AND status<>'void'`, [id]);
        if (saved!.n > 0) throw conflict('No puedes cambiar el tipo de meta (real/virtual) después de registrar aportes', 'goal_has_savings');
      }
      const m = { ...before, ...b };
      const g = await one(c, `UPDATE goals SET name=$3,target_amount=$4,target_date=$5,priority=$6,contribution_amount=$7,contribution_frequency=$8,account_id=$9,status=$10 WHERE id=$1 AND user_id=$2 RETURNING *`, [id, uid(req), m.name, m.target_amount, m.target_date ?? null, m.priority, m.contribution_amount ?? null, m.contribution_frequency ?? null, m.account_id ?? null, m.status]);
      await audit(c, uid(req), 'goal', id, 'update', before, g);
      return g;
    });
  });
  app.post('/api/goals/:id/contribute', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ account_id: uuid, amount: z.number().int().safe(), occurred_at: z.string().datetime({ offset: true }).optional(), description: z.string().max(200).optional() }), req.body);
    return mutate(uid(req), (c) => createTransaction(c, uid(req), { type: 'goal_saving', goal_id: id, account_id: b.account_id, amount: b.amount, occurred_at: b.occurred_at, description: b.description ?? (b.amount < 0 ? 'Retiro de meta' : 'Aporte a meta') }));
  });

  // ---------- Deudas ----------
  app.get('/api/debts', async (req) => debtsWithRemaining(pool, uid(req)));
  app.post('/api/debts', async (req) => {
    const b = parse(z.object({
      direction: z.enum(['owe', 'owed']), counterparty: z.string().trim().min(1).max(100), original_amount: z.number().int().positive(), currency: z.string().length(3).toUpperCase().optional(),
      due_date: isoDate.nullish(), interest_rate: z.number().min(0).max(1000).nullish(), notes: z.string().max(500).nullish(),
      // Si el dinero del préstamo entró/salió de una cuenta, se registra ese movimiento (no cuenta como ingreso/gasto real).
      cash_account_id: uuid.nullish(), cash_date: z.string().datetime({ offset: true }).optional(),
    }), req.body);
    const u = await getUser(pool, uid(req));
    return mutate(uid(req), async (c) => {
      const d = await one(c, `INSERT INTO debts(user_id,direction,counterparty,original_amount,currency,due_date,interest_rate,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [uid(req), b.direction, b.counterparty, b.original_amount, b.currency ?? u.currency, b.due_date ?? null, b.interest_rate ?? null, b.notes ?? null]);
      await audit(c, uid(req), 'debt', d.id, 'create', null, d);
      if (b.cash_account_id) {
        await createTransaction(c, uid(req), { type: b.direction === 'owe' ? 'income' : 'expense', amount: b.original_amount, account_id: b.cash_account_id, debt_id: d.id, occurred_at: b.cash_date, merchant: b.counterparty, description: b.direction === 'owe' ? 'Préstamo recibido' : 'Préstamo otorgado' });
      }
      return d;
    });
  });
  app.patch('/api/debts/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ counterparty: z.string().trim().min(1).max(100), due_date: isoDate.nullable(), interest_rate: z.number().min(0).max(1000).nullable(), notes: z.string().max(500).nullable(), status: z.enum(['open', 'closed']) }).partial(), req.body);
    const before = await one(pool, 'SELECT * FROM debts WHERE id=$1 AND user_id=$2', [id, uid(req)]);
    if (!before) throw notFound('Deuda');
    const m = { ...before, ...b };
    const d = await one(pool, `UPDATE debts SET counterparty=$3,due_date=$4,interest_rate=$5,notes=$6,status=$7 WHERE id=$1 AND user_id=$2 RETURNING *`, [id, uid(req), m.counterparty, m.due_date, m.interest_rate, m.notes, m.status]);
    await audit(pool, uid(req), 'debt', id, 'update', before, d);
    return d;
  });
  app.post('/api/debts/:id/payments', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ account_id: uuid, amount: z.number().int().positive(), occurred_at: z.string().datetime({ offset: true }).optional(), description: z.string().max(200).optional() }), req.body);
    return mutate(uid(req), async (c) => {
      const d = await one(c, 'SELECT * FROM debts WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, uid(req)]);
      if (!d) throw notFound('Deuda');
      const r = await createTransaction(c, uid(req), { type: d.direction === 'owe' ? 'debt_payment' : 'debt_collection', debt_id: id, account_id: b.account_id, amount: b.amount, occurred_at: b.occurred_at, merchant: d.counterparty, description: b.description ?? (d.direction === 'owe' ? 'Pago de deuda' : 'Cobro de deuda') });
      await syncDebt(c, id);
      return r;
    });
  });
  app.get('/api/debts/:id/payments', async (req) => {
    const { id } = parse(idParam, req.params);
    return rows(pool, `SELECT id, type, amount, occurred_at, status, account_id, description FROM transactions WHERE debt_id=$1 AND user_id=$2 ORDER BY occurred_at`, [id, uid(req)]);
  });

  // ---------- Recurrencias ----------
  const recBody = z.object({
    name: z.string().trim().min(1).max(80), kind: z.enum(['subscription', 'bill', 'service', 'debt', 'other']).default('subscription'), amount: z.number().int().positive(),
    frequency: z.enum(['weekly', 'biweekly', 'monthly', 'yearly']), next_date: isoDate, account_id: uuid.nullish(), category_id: uuid.nullish(), debt_id: uuid.nullish(), active: z.boolean().default(true),
    origin: z.enum(['manual', 'suggested']).default('manual'),
  });
  app.get('/api/recurring', async (req) => rows(pool, `SELECT r.*, c.name AS category_name, a.name AS account_name FROM recurring r LEFT JOIN categories c ON c.id=r.category_id LEFT JOIN accounts a ON a.id=r.account_id WHERE r.user_id=$1 ORDER BY r.active DESC, r.next_date`, [uid(req)]));
  app.get('/api/recurring/suggestions', async (req) => suggestRecurring(pool, uid(req)));
  app.post('/api/recurring', async (req) => {
    const b = parse(recBody, req.body);
    const u = await getUser(pool, uid(req));
    return mutate(uid(req), async (c) => {
      const r = await one(c, `INSERT INTO recurring(user_id,name,kind,amount,currency,frequency,next_date,account_id,category_id,debt_id,active,origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [uid(req), b.name, b.kind, b.amount, u.currency, b.frequency, b.next_date, b.account_id ?? null, b.category_id ?? null, b.debt_id ?? null, b.active, b.origin]);
      await audit(c, uid(req), 'recurring', r.id, 'create', null, r);
      return r;
    });
  });
  app.patch('/api/recurring/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(recBody.partial(), req.body);
    const before = await one(pool, 'SELECT * FROM recurring WHERE id=$1 AND user_id=$2', [id, uid(req)]);
    if (!before) throw notFound('Pago recurrente');
    const m = { ...before, ...b };
    const r = await one(pool, `UPDATE recurring SET name=$3,kind=$4,amount=$5,frequency=$6,next_date=$7,account_id=$8,category_id=$9,debt_id=$10,active=$11 WHERE id=$1 AND user_id=$2 RETURNING *`, [id, uid(req), m.name, m.kind, m.amount, m.frequency, m.next_date, m.account_id ?? null, m.category_id ?? null, m.debt_id ?? null, m.active]);
    await audit(pool, uid(req), 'recurring', id, 'update', before, r);
    return r;
  });
  app.delete('/api/recurring/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await pool.query('DELETE FROM recurring WHERE id=$1 AND user_id=$2 RETURNING id', [id, uid(req)]);
    if (!r.rowCount) throw notFound('Pago recurrente');
    await audit(pool, uid(req), 'recurring', id, 'delete');
    return { ok: true };
  });
  // Registrar el pago de una ocurrencia: crea el movimiento real y avanza la fecha.
  app.post('/api/recurring/:id/pay', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ account_id: uuid.optional(), amount: z.number().int().positive().optional(), occurred_at: z.string().datetime({ offset: true }).optional() }), req.body);
    return mutate(uid(req), async (c) => {
      const r = await one(c, 'SELECT * FROM recurring WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, uid(req)]);
      if (!r) throw notFound('Pago recurrente');
      const account_id = b.account_id ?? r.account_id;
      if (!account_id) throw badRequest('Indica la cuenta con la que se paga', 'validation', { account_id: 'Requerida' });
      let tx;
      if (r.debt_id) {
        const d = await one(c, 'SELECT * FROM debts WHERE id=$1 AND user_id=$2', [r.debt_id, uid(req)]);
        tx = await createTransaction(c, uid(req), { type: d.direction === 'owe' ? 'debt_payment' : 'debt_collection', debt_id: r.debt_id, account_id, amount: b.amount ?? r.amount, occurred_at: b.occurred_at, merchant: r.name });
        await syncDebt(c, r.debt_id);
      } else {
        tx = await createTransaction(c, uid(req), { type: 'expense', account_id, amount: b.amount ?? r.amount, occurred_at: b.occurred_at, merchant: r.name, category_id: r.category_id, description: `Pago recurrente (${r.kind})` });
      }
      const next = nextOccurrence(r.next_date, r.frequency);
      await c.query('UPDATE recurring SET next_date=$2 WHERE id=$1', [id, next]);
      await audit(c, uid(req), 'recurring', id, 'paid', { next_date: r.next_date }, { next_date: next });
      return { transaction: tx.tx, next_date: next };
    });
  });
}
