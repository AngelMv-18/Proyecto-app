import { Db, one } from '../db.js';
import { createTransaction } from './ledger.js';
import { ParsedMessage } from './parser.js';

export type IngestOutcome = { outcome: 'created' | 'duplicate' | 'ignored'; reason?: string; tx_id?: string };

/** Convierte un mensaje ya interpretado en un movimiento PENDIENTE de revisión (nunca confirmado automáticamente). */
export async function ingestParsed(db: Db, userId: string, p: ParsedMessage, o: { account_id: string; source: 'email' | 'notification'; label: string; import_id?: string | null }): Promise<IngestOutcome> {
  if (p.kind === 'ignored') return { outcome: 'ignored', reason: p.reason };
  const acc = await one(db, 'SELECT currency, archived FROM accounts WHERE id=$1 AND user_id=$2', [o.account_id, userId]);
  if (!acc || acc.archived) return { outcome: 'ignored', reason: 'La cuenta destino no existe o está archivada' };
  if (acc.currency !== p.currency) return { outcome: 'ignored', reason: `Moneda detectada (${p.currency}) distinta a la de la cuenta (${acc.currency}); revísalo manualmente` };
  try {
    const r = await createTransaction(db, userId, {
      type: p.type!, amount: p.amount!, occurred_at: p.occurred_at, account_id: o.account_id, merchant: p.merchant ?? null,
      source: o.source, status: 'pending', needs_review: true, external_id: p.external_id ?? null,
      source_label: `${o.label}${p.bank_state === 'pending' ? ' (pendiente en el banco)' : ''}`.slice(0, 200),
      description: p.reference ? `Ref. ${p.reference}` : null, import_id: o.import_id ?? null,
    });
    return r.duplicate ? { outcome: 'duplicate', tx_id: r.tx.id } : { outcome: 'created', tx_id: r.tx.id };
  } catch (e: any) {
    return { outcome: 'ignored', reason: e?.message ?? 'No se pudo registrar' };
  }
}
