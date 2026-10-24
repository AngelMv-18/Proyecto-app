import { Db, one } from '../db.js';
import { createTransaction } from './ledger.js';
import { ParsedMessage } from './parser.js';

export type IngestOutcome = { outcome: 'created' | 'duplicate' | 'ignored'; reason?: string; tx_id?: string };

/** Convierte un mensaje ya interpretado en un movimiento PENDIENTE de revisión (nunca confirmado automáticamente). */
export async function ingestParsed(db: Db, userId: string, p: ParsedMessage, o: { account_id: string; source: 'email' | 'notification'; label: string; import_id?: string | null }): Promise<IngestOutcome> {
  if (p.kind === 'ignored') return { outcome: 'ignored', reason: p.reason };
  const accountId = (await matchAccount(db, userId, p)) ?? o.account_id;
  const acc = await one(db, 'SELECT currency, archived FROM accounts WHERE id=$1 AND user_id=$2', [accountId, userId]);
  if (!acc || acc.archived) return { outcome: 'ignored', reason: 'La cuenta destino no existe o está archivada' };
  if (acc.currency !== p.currency) return { outcome: 'ignored', reason: `Moneda detectada (${p.currency}) distinta a la de la cuenta (${acc.currency}); revísalo manualmente` };
  try {
    const r = await createTransaction(db, userId, {
      type: p.type!, amount: p.amount!, occurred_at: p.occurred_at, account_id: accountId, merchant: p.merchant ?? null,
      source: o.source, status: 'pending', needs_review: true, external_id: p.external_id ?? null,
      source_label: `${o.label}${p.bank_state === 'pending' ? ' (pendiente en el banco)' : ''}`.slice(0, 200),
      description: [p.description, p.reference ? `Ref. ${p.reference}` : null].filter(Boolean).join(' · ') || null, import_id: o.import_id ?? null,
    });
    return r.duplicate ? { outcome: 'duplicate', tx_id: r.tx.id } : { outcome: 'created', tx_id: r.tx.id };
  } catch (e: any) {
    return { outcome: 'ignored', reason: e?.message ?? 'No se pudo registrar' };
  }
}

/**
 * Cuenta a la que corresponde el aviso: primero por los últimos 4 dígitos de la tarjeta o cuenta (si el usuario los
 * guardó en la apariencia de la tarjeta), luego por banco si solo hay una cuenta de ese banco en la misma moneda.
 * Si no hay coincidencia clara se usa la cuenta destino elegida por el usuario.
 */
export async function matchAccount(db: Db, userId: string, p: ParsedMessage): Promise<string | null> {
  if (p.card_last4) {
    const r = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE user_id=$1 AND NOT archived AND last4=$2 ORDER BY (currency=$3) DESC, created_at LIMIT 1`, [userId, p.card_last4, p.currency ?? '']);
    if (r) return r.id;
  }
  if (p.bank) {
    const r = await db.query<{ id: string }>(`SELECT id FROM accounts WHERE user_id=$1 AND NOT archived AND bank_code=$2 AND currency=$3`, [userId, p.bank, p.currency ?? '']);
    if (r.rows.length === 1) return r.rows[0].id;
  }
  return null;
}
