import { z } from 'zod';
import { Db, one, rows } from '../db.js';
import { audit } from '../audit.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';

export const TX_TYPES = ['income', 'expense', 'transfer', 'debt_payment', 'debt_collection', 'refund', 'adjustment', 'goal_saving'] as const;
export type TxType = (typeof TX_TYPES)[number];

const id = z.string().uuid();
export const txInputSchema = z.object({
  type: z.enum(TX_TYPES),
  amount: z.number().int().safe(),
  to_amount: z.number().int().positive().safe().nullish(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  account_id: id,
  to_account_id: id.nullish(),
  category_id: id.nullish(),
  merchant: z.string().trim().max(120).nullish(),
  payment_method: z.string().trim().max(40).nullish(),
  description: z.string().trim().max(500).nullish(),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
  nature: z.enum(['essential', 'discretionary', 'extraordinary']).nullish(),
  status: z.enum(['pending', 'confirmed']).optional(),
  source: z.enum(['manual', 'email', 'import', 'notification', 'bank_api']).optional(),
  needs_review: z.boolean().optional(),
  external_id: z.string().max(200).nullish(),
  source_label: z.string().max(200).nullish(),
  import_id: id.nullish(),
  debt_id: id.nullish(),
  goal_id: id.nullish(),
  refund_of: id.nullish(),
});
export type TxInput = z.infer<typeof txInputSchema>;
export const txPatchSchema = txInputSchema.partial().omit({ source: true, external_id: true, import_id: true, status: true, needs_review: true });

const norm = (s?: string | null) => (s ?? '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
export function similarMerchant(a?: string | null, b?: string | null) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return true; // sin comercio en alguno de los dos: no hay evidencia en contra
  return x === y || x.includes(y) || y.includes(x) || x.slice(0, 4) === y.slice(0, 4);
}

async function userTz(db: Db, userId: string) {
  return (await one<{ timezone: string; currency: string }>(db, 'SELECT timezone, currency FROM users WHERE id=$1', [userId]))!;
}
async function account(db: Db, userId: string, accId: string, label = 'Cuenta') {
  const a = await one(db, 'SELECT * FROM accounts WHERE id=$1 AND user_id=$2', [accId, userId]);
  if (!a) throw badRequest(`${label} no válida`, 'invalid_account', { account_id: `${label} no existe` });
  return a;
}

export async function accountBalance(db: Db, accId: string, asOfExclusive?: string): Promise<number> {
  const r = await one<{ b: number }>(
    db,
    `SELECT a.opening_balance + COALESCE((SELECT SUM(delta) FROM v_effects e WHERE e.account_id=a.id ${asOfExclusive ? 'AND e.occurred_at < $2' : ''}),0) AS b
       FROM accounts a WHERE a.id=$1`,
    asOfExclusive ? [accId, asOfExclusive] : [accId],
  );
  return r?.b ?? 0;
}
export async function debtRemaining(db: Db, debtId: string, excludeTx?: string) {
  const r = await one<{ rem: number }>(
    db,
    `SELECT d.original_amount - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.debt_id=d.id AND t.type IN ('debt_payment','debt_collection') AND t.status='confirmed' AND ($2::uuid IS NULL OR t.id<>$2)),0) AS rem
       FROM debts d WHERE d.id=$1`,
    [debtId, excludeTx ?? null],
  );
  return r?.rem ?? 0;
}
export async function goalSaved(db: Db, goalId: string, excludeTx?: string) {
  const r = await one<{ s: number }>(
    db,
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE goal_id=$1 AND type='goal_saving' AND status='confirmed' AND ($2::uuid IS NULL OR id<>$2)`,
    [goalId, excludeTx ?? null],
  );
  return r!.s;
}
async function virtualReserved(db: Db, accId: string, excludeTx?: string) {
  const r = await one<{ s: number }>(
    db,
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id=$1 AND type='goal_saving' AND to_account_id IS NULL AND status='confirmed' AND ($2::uuid IS NULL OR id<>$2)`,
    [accId, excludeTx ?? null],
  );
  return r!.s;
}

type Row = Record<string, any>;

/** Valida reglas contables y devuelve la fila normalizada. Lanza AppError con mensajes en español. */
export async function validateTx(db: Db, userId: string, t: Row, excludeId?: string): Promise<Row> {
  const u = await userTz(db, userId);
  const acc = await account(db, userId, t.account_id, 'Cuenta de origen');
  if (acc.archived) throw badRequest('La cuenta de origen está archivada', 'account_archived', { account_id: 'Cuenta archivada' });
  const out: Row = { ...t, currency: acc.currency, tags: t.tags ?? [] };

  if (t.type !== 'adjustment' && t.type !== 'goal_saving' && t.amount <= 0) throw badRequest('El importe debe ser mayor que cero', 'validation', { amount: 'Debe ser mayor que cero' });
  if (t.amount === 0) throw badRequest('El importe no puede ser cero', 'validation', { amount: 'No puede ser cero' });

  // Fecha anterior al saldo inicial: rompería la coherencia del saldo.
  const early = await one(db, `SELECT 1 FROM accounts WHERE id=$1 AND ($2::timestamptz AT TIME ZONE $3)::date < opening_date`, [acc.id, t.occurred_at, u.timezone]);
  if (early) throw badRequest(`La fecha es anterior al saldo inicial de "${acc.name}" (${acc.opening_date})`, 'before_opening', { occurred_at: 'Anterior al saldo inicial de la cuenta' });

  if (t.category_id) {
    const c = await one(db, 'SELECT id FROM categories WHERE id=$1 AND user_id=$2', [t.category_id, userId]);
    if (!c) throw badRequest('Categoría no válida', 'invalid_category', { category_id: 'No existe' });
  }
  if (t.type !== 'transfer' && t.type !== 'goal_saving') {
    if (t.to_account_id) throw badRequest('Solo las transferencias tienen cuenta de destino', 'validation', { to_account_id: 'No aplica' });
    out.to_amount = null;
  }

  switch (t.type as TxType) {
    case 'transfer': {
      if (!t.to_account_id) throw badRequest('Falta la cuenta de destino', 'validation', { to_account_id: 'Requerida' });
      if (t.to_account_id === t.account_id) throw badRequest('Origen y destino deben ser distintas', 'validation', { to_account_id: 'Debe ser distinta' });
      const to = await account(db, userId, t.to_account_id, 'Cuenta de destino');
      if (to.archived) throw badRequest('La cuenta de destino está archivada', 'account_archived');
      if (to.currency !== acc.currency && !t.to_amount) throw badRequest('Las cuentas tienen monedas distintas: indica el importe recibido', 'fx_amount_required', { to_amount: 'Requerido' });
      if (to.currency === acc.currency) out.to_amount = null;
      out.category_id = null;
      break;
    }
    case 'debt_payment':
    case 'debt_collection': {
      const d = await one(db, 'SELECT * FROM debts WHERE id=$1 AND user_id=$2', [t.debt_id, userId]);
      if (!d) throw badRequest('Deuda no válida', 'invalid_debt', { debt_id: 'No existe' });
      if ((t.type === 'debt_payment') !== (d.direction === 'owe')) throw badRequest(t.type === 'debt_payment' ? 'Solo se pagan deudas propias' : 'Solo se cobran deudas que te deben', 'debt_direction');
      if (d.currency !== acc.currency) throw badRequest('La moneda de la cuenta no coincide con la de la deuda', 'currency_mismatch');
      if (d.status === 'closed') throw conflict('La deuda ya está saldada', 'debt_closed');
      if ((t.status ?? 'confirmed') === 'confirmed') {
        const rem = await debtRemaining(db, d.id, excludeId);
        if (t.amount > rem) throw badRequest(`El importe excede el saldo pendiente de la deuda (${rem / 100})`, 'debt_overpay', { amount: 'Excede lo pendiente' });
      }
      break;
    }
    case 'income':
    case 'expense': {
      if (t.debt_id) {
        // Origen de una deuda: préstamo recibido (income / owe) o prestado (expense / owed).
        const d = await one(db, 'SELECT * FROM debts WHERE id=$1 AND user_id=$2', [t.debt_id, userId]);
        if (!d) throw badRequest('Deuda no válida', 'invalid_debt');
        const ok = (t.type === 'income' && d.direction === 'owe') || (t.type === 'expense' && d.direction === 'owed');
        if (!ok) throw badRequest('Este movimiento no es coherente con el tipo de deuda', 'debt_direction');
      }
      break;
    }
    case 'refund': {
      const o = await one(db, 'SELECT * FROM transactions WHERE id=$1 AND user_id=$2', [t.refund_of, userId]);
      if (!o || o.type !== 'expense' || o.status !== 'confirmed') throw badRequest('La devolución debe referirse a un gasto confirmado', 'invalid_refund', { refund_of: 'Gasto original no válido' });
      if (o.currency !== acc.currency) throw badRequest('La devolución debe ser en la misma moneda del gasto', 'currency_mismatch');
      const prev = await one<{ s: number }>(db, `SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE refund_of=$1 AND type='refund' AND status IN ('confirmed','pending') AND ($2::uuid IS NULL OR id<>$2)`, [o.id, excludeId ?? null]);
      if (prev!.s + t.amount > o.amount) throw badRequest(`La devolución excede el gasto original (restante reembolsable: ${(o.amount - prev!.s) / 100})`, 'refund_exceeds', { amount: 'Excede el gasto original' });
      if (!t.category_id) out.category_id = o.category_id;
      if (!t.merchant) out.merchant = o.merchant;
      break;
    }
    case 'goal_saving': {
      const g = await one(db, 'SELECT * FROM goals WHERE id=$1 AND user_id=$2', [t.goal_id, userId]);
      if (!g) throw badRequest('Meta no válida', 'invalid_goal', { goal_id: 'No existe' });
      if (g.status !== 'active') throw conflict('La meta no está activa', 'goal_inactive');
      out.category_id = null;
      out.to_account_id = g.account_id; // meta con cuenta real: el dinero se mueve; si no, es reserva virtual
      if (g.account_id) {
        if (g.account_id === t.account_id) throw badRequest('La cuenta de origen es la misma que la cuenta de la meta', 'validation', { account_id: 'Elige otra cuenta' });
        const to = await account(db, userId, g.account_id, 'Cuenta de la meta');
        if (to.currency !== acc.currency && !t.to_amount) throw badRequest('Monedas distintas: indica el importe recibido', 'fx_amount_required', { to_amount: 'Requerido' });
        if (to.currency === acc.currency) out.to_amount = null;
      } else out.to_amount = null;
      if (acc.currency !== u.currency) throw badRequest('Las metas se manejan en la moneda principal; usa una cuenta en esa moneda', 'currency_mismatch', { account_id: 'Moneda distinta a la principal' });
      if ((t.status ?? 'confirmed') === 'confirmed') {
        const saved = await goalSaved(db, g.id, excludeId);
        if (saved + t.amount < 0) throw badRequest('No puedes retirar más de lo ahorrado en la meta', 'goal_negative', { amount: 'Excede lo ahorrado' });
        if (!g.account_id && t.amount > 0) {
          // Sin dinero ficticio: lo reservado virtualmente en una cuenta no puede exceder su saldo.
          const bal = await accountBalance(db, acc.id);
          const reserved = await virtualReserved(db, acc.id, excludeId);
          if (reserved + t.amount > Math.max(bal, 0)) throw badRequest(`Saldo insuficiente en "${acc.name}" para reservar este importe (libre: ${Math.max(bal - reserved, 0) / 100})`, 'insufficient_funds', { amount: 'Saldo libre insuficiente' });
        }
      }
      break;
    }
    case 'adjustment':
      out.category_id = null;
      break;
  }
  return out;
}

async function findDuplicate(db: Db, userId: string, t: Row) {
  // 1) mismo identificador externo
  if (t.external_id) {
    const r = await one(db, 'SELECT * FROM transactions WHERE user_id=$1 AND external_id=$2', [userId, t.external_id]);
    if (r) return { tx: r, kind: r.source !== t.source ? ('cross' as const) : ('external' as const) };
  }
  if (!t.source || t.source === 'manual' || !['income', 'expense'].includes(t.type)) return null;
  // 2) mismo importe/fecha/comercio visto por otra fuente (p. ej. notificación + correo)
  const cands = await rows(
    db,
    `SELECT * FROM transactions WHERE user_id=$1 AND status<>'void' AND type=$2 AND amount=$3 AND currency=$4
        AND occurred_at BETWEEN $5::timestamptz - interval '36 hours' AND $5::timestamptz + interval '36 hours'`,
    [userId, t.type, t.amount, t.currency, t.occurred_at],
  );
  for (const c of cands) {
    if (!similarMerchant(c.merchant, t.merchant)) continue;
    return { tx: c, kind: c.source !== t.source ? ('cross' as const) : ('same' as const) };
  }
  return null;
}

export type CreateResult = { tx: Row; duplicate: boolean; duplicate_of?: string; flagged?: boolean };

export async function createTransaction(db: Db, userId: string, input: TxInput): Promise<CreateResult> {
  const source = input.source ?? 'manual';
  const detected = source !== 'manual';
  const status = input.status ?? (detected ? 'pending' : 'confirmed');
  const base: Row = { ...input, source, status, occurred_at: input.occurred_at ?? new Date().toISOString(), needs_review: input.needs_review ?? (detected && status === 'pending') };
  const t = await validateTx(db, userId, base);

  const dup = await findDuplicate(db, userId, t);
  if (dup) {
    if (dup.kind === 'external' || dup.kind === 'cross') {
      // No se crea otra fila; se enriquece la fuente de la existente.
      if (dup.kind === 'cross' && !String(dup.tx.source_label ?? '').includes(t.source_label ?? '§')) {
        const label = [dup.tx.source_label, t.source_label ?? t.source].filter(Boolean).join(' + ').slice(0, 200);
        await db.query('UPDATE transactions SET source_label=$2, updated_at=now() WHERE id=$1', [dup.tx.id, label]);
        await audit(db, userId, 'transaction', dup.tx.id, 'duplicate_merged', null, { from: t.source, label });
      }
      return { tx: dup.tx, duplicate: true, duplicate_of: dup.tx.id };
    }
    t.needs_review = true; // misma fuente, mismo importe: puede ser una compra real repetida; se pide revisión
    t.duplicate_of = dup.tx.id;
  }

  const r = await one(
    db,
    `INSERT INTO transactions(user_id,type,amount,to_amount,currency,occurred_at,account_id,to_account_id,category_id,merchant,payment_method,description,tags,nature,status,source,needs_review,external_id,source_label,import_id,debt_id,goal_id,refund_of,duplicate_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [userId, t.type, t.amount, t.to_amount ?? null, t.currency, t.occurred_at, t.account_id, t.to_account_id ?? null, t.category_id ?? null, t.merchant ?? null, t.payment_method ?? null, t.description ?? null, t.tags, t.nature ?? null, t.status, t.source, t.needs_review, t.external_id ?? null, t.source_label ?? null, t.import_id ?? null, t.debt_id ?? null, t.goal_id ?? null, t.refund_of ?? null, t.duplicate_of ?? null],
  );
  await audit(db, userId, 'transaction', r.id, 'create', null, r);
  return { tx: r, duplicate: false, flagged: Boolean(dup) };
}

const EDITABLE = ['type', 'amount', 'to_amount', 'occurred_at', 'account_id', 'to_account_id', 'category_id', 'merchant', 'payment_method', 'description', 'tags', 'nature', 'debt_id', 'goal_id', 'refund_of'] as const;

export async function getTx(db: Db, userId: string, txId: string) {
  const t = await one(db, 'SELECT * FROM transactions WHERE id=$1 AND user_id=$2', [txId, userId]);
  if (!t) throw notFound('Movimiento');
  return t;
}

export async function updateTransaction(db: Db, userId: string, txId: string, patch: z.infer<typeof txPatchSchema>) {
  const before = await getTx(db, userId, txId);
  if (before.status === 'void') throw conflict('Un movimiento anulado no se puede editar', 'tx_void');
  const merged: Row = { ...before };
  for (const k of EDITABLE) if ((patch as Row)[k] !== undefined) merged[k] = (patch as Row)[k];
  if (merged.occurred_at instanceof Date) merged.occurred_at = merged.occurred_at.toISOString();
  const t = await validateTx(db, userId, merged, txId);
  // Un gasto con devoluciones no puede quedar por debajo de lo ya reembolsado.
  if (before.type === 'expense') {
    const refunded = await one<{ s: number }>(db, `SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE refund_of=$1 AND status<>'void'`, [txId]);
    if (t.type !== 'expense' || t.amount < refunded!.s || t.account_id !== before.account_id) throw conflict('Este gasto tiene devoluciones registradas: anúlalas antes de cambiar su tipo, cuenta o importe', 'has_refunds');
  }
  const r = await one(
    db,
    `UPDATE transactions SET type=$3,amount=$4,to_amount=$5,currency=$6,occurred_at=$7,account_id=$8,to_account_id=$9,category_id=$10,merchant=$11,payment_method=$12,description=$13,tags=$14,nature=$15,debt_id=$16,goal_id=$17,refund_of=$18,updated_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING *`,
    [txId, userId, t.type, t.amount, t.to_amount ?? null, t.currency, t.occurred_at, t.account_id, t.to_account_id ?? null, t.category_id ?? null, t.merchant ?? null, t.payment_method ?? null, t.description ?? null, t.tags, t.nature ?? null, t.debt_id ?? null, t.goal_id ?? null, t.refund_of ?? null],
  );
  await audit(db, userId, 'transaction', txId, 'update', before, r);
  return r;
}

/** Anulación (reversión segura): la fila se conserva con su historial; deja de afectar saldos e indicadores. */
export async function voidTransaction(db: Db, userId: string, txId: string, reason: string) {
  const before = await getTx(db, userId, txId);
  if (before.status === 'void') throw conflict('El movimiento ya está anulado', 'tx_void');
  if (before.type === 'expense') {
    const r = await one(db, `SELECT 1 FROM transactions WHERE refund_of=$1 AND status<>'void'`, [txId]);
    if (r) throw conflict('Primero anula las devoluciones asociadas a este gasto', 'has_refunds');
  }
  if (before.type === 'goal_saving' && before.status === 'confirmed' && before.amount > 0) {
    const saved = await goalSaved(db, before.goal_id, txId);
    if (saved < 0) throw conflict('Anular este aporte dejaría la meta con saldo negativo', 'goal_negative');
  }
  if (before.type === 'income' && before.debt_id) {
    const used = await one(db, `SELECT 1 FROM transactions WHERE debt_id=$1 AND type IN ('debt_payment','debt_collection') AND status='confirmed'`, [before.debt_id]);
    if (used) throw conflict('La deuda ya tiene pagos registrados; anúlalos primero', 'debt_has_payments');
  }
  const r = await one(db, `UPDATE transactions SET status='void', needs_review=false, void_reason=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [txId, userId, reason]);
  await audit(db, userId, 'transaction', txId, 'void', before, r, reason);
  return r;
}

/** Revisión de movimientos detectados: confirmar (con correcciones opcionales) los vuelve parte de los saldos. */
export async function confirmTransaction(db: Db, userId: string, txId: string, patch?: z.infer<typeof txPatchSchema>) {
  let before = await getTx(db, userId, txId);
  if (before.status === 'void') throw conflict('El movimiento está anulado', 'tx_void');
  if (patch && Object.keys(patch).length) {
    await updateTransaction(db, userId, txId, patch);
    before = await getTx(db, userId, txId);
  }
  if (before.status === 'confirmed' && !before.needs_review) return before;
  const t = await validateTx(db, userId, { ...before, occurred_at: before.occurred_at.toISOString(), status: 'confirmed' }, txId);
  void t;
  const r = await one(db, `UPDATE transactions SET status='confirmed', needs_review=false, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [txId, userId]);
  await audit(db, userId, 'transaction', txId, 'confirm', before, r);
  return r;
}

/** Descarta un movimiento detectado que nunca fue confirmado. Los confirmados solo se pueden anular. */
export async function discardPending(db: Db, userId: string, txId: string, reason = 'Descartado en revisión') {
  const before = await getTx(db, userId, txId);
  if (before.status === 'confirmed') throw new AppError(409, 'tx_confirmed', 'Un movimiento confirmado no se elimina: anúlalo para conservar el historial');
  if (before.status === 'void') return before;
  const r = await one(db, `UPDATE transactions SET status='void', needs_review=false, void_reason=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`, [txId, userId, reason]);
  await audit(db, userId, 'transaction', txId, 'discard', before, r, reason);
  return r;
}
