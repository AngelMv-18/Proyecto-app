import { Db, one, rows } from '../db.js';
import { createTransaction, resolveLinked } from './ledger.js';
import { ParsedMessage, bankOf } from './parser.js';

export type IngestOutcome = { outcome: 'created' | 'duplicate' | 'ignored'; reason?: string; tx_id?: string; ask_account?: boolean };

// Tipo de cambio de referencia (aproximado) cuando el usuario no definió el suyo en Perfil. Solo sirve para estimar el
// importe de un cobro en dólares en una cuenta en lempiras; el movimiento queda "por revisar" con el aviso correspondiente.
const REFERENCE_RATES: Record<string, Record<string, number>> = { HNL: { USD: 26.5 } };

const norm = (s?: string | null) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
type Acc = { id: string; name: string; type: string; bank_code: string | null; last4: string | null; currency: string; linked_account_id: string | null };
const activeAccounts = (db: Db, userId: string) =>
  rows<Acc>(db, `SELECT id, name, type, bank_code, last4, currency, linked_account_id FROM accounts WHERE user_id=$1 AND NOT archived ORDER BY created_at`, [userId]);

/**
 * Cuenta a la que corresponde el aviso, en este orden:
 *  1. los últimos 4 dígitos de la tarjeta o cuenta,
 *  2. la "forma de pago" que indica el recibo (nombre de la tarjeta, o banco + débito/crédito),
 *  3. el banco, si todas sus cuentas son en realidad el mismo dinero (tarjeta de débito vinculada a su cuenta).
 * Si no hay una coincidencia clara devuelve null: el movimiento se registra en la cuenta destino elegida y la app
 * pregunta de qué tarjeta o cuenta es.
 */
export async function matchAccount(db: Db, userId: string, p: ParsedMessage): Promise<string | null> {
  const accs = await activeAccounts(db, userId);
  if (p.card_last4) {
    const m = accs.filter((a) => a.last4 === p.card_last4);
    if (m.length) return (m.find((a) => a.currency === p.currency) ?? m[0]).id;
  }
  if (p.payment_hint) {
    const h = norm(p.payment_hint);
    const byName = accs.filter((a) => { const n = norm(a.name); return n.length >= 4 && (n === h || h.includes(n) || n.includes(h)); });
    if (byName.length === 1) return byName[0].id;
    const kind = /credito/.test(h) ? 'credit_card' : /debito/.test(h) ? 'debit_card' : null;
    const bank = bankOf(p.payment_hint);
    if (bank && kind) {
      const m = accs.filter((a) => a.bank_code === bank && a.type === kind);
      if (m.length === 1) return m[0].id;
    }
  }
  if (p.bank) {
    const m = accs.filter((a) => a.bank_code === p.bank);
    if (m.length && new Set(m.map((a) => a.linked_account_id ?? a.id)).size === 1) return m[0].id;
  }
  return null;
}

/** ¿Hay más de un lugar donde podría haber salido el dinero? (una tarjeta de débito vinculada cuenta como su cuenta) */
async function hasSeveralPlaces(db: Db, userId: string) {
  const accs = await activeAccounts(db, userId);
  return new Set(accs.map((a) => a.linked_account_id ?? a.id)).size > 1;
}

/** Pasa un importe a la moneda de la cuenta con el tipo de cambio del usuario o, si no hay, el de referencia. */
async function convert(db: Db, userId: string, amount: number, from: string, to: string) {
  const u = await one<{ currency: string }>(db, 'SELECT currency FROM users WHERE id=$1', [userId]);
  if (!u || u.currency !== to) return null; // solo hacia la moneda principal
  const own = await one<{ rate: string }>(db, 'SELECT rate FROM fx_rates WHERE user_id=$1 AND currency=$2', [userId, from]);
  const rate = own ? Number(own.rate) : REFERENCE_RATES[to]?.[from];
  if (!rate) return null;
  return { amount: Math.round(amount * rate), rate, own: Boolean(own) };
}

/** Convierte un mensaje ya interpretado en un movimiento PENDIENTE de revisión (nunca confirmado automáticamente). */
export async function ingestParsed(db: Db, userId: string, p: ParsedMessage, o: { account_id: string; source: 'email' | 'notification'; label: string; import_id?: string | null; ask_if_unmatched?: boolean }): Promise<IngestOutcome> {
  if (p.kind === 'ignored') return { outcome: 'ignored', reason: p.reason };
  const matched = await matchAccount(db, userId, p);
  const accountId = matched ?? o.account_id;
  const dest = await one<{ id: string; archived: boolean }>(db, 'SELECT id, archived FROM accounts WHERE id=$1 AND user_id=$2', [accountId, userId]);
  if (!dest || dest.archived) return { outcome: 'ignored', reason: 'La cuenta destino no existe o está archivada' };
  // Una tarjeta de débito vinculada usa la moneda de su cuenta.
  const eff = await resolveLinked(db, userId, accountId);
  const acc = await one<{ currency: string }>(db, 'SELECT currency FROM accounts WHERE id=$1', [eff.id]);
  let amount = p.amount!; let hint: string | null = null;
  if (acc!.currency !== p.currency) {
    const c = await convert(db, userId, p.amount!, p.currency!, acc!.currency);
    if (!c) return { outcome: 'ignored', reason: `Moneda detectada (${p.currency}) distinta a la de la cuenta (${acc!.currency}); revísalo manualmente` };
    amount = c.amount;
    const orig = `${p.currency} ${(p.amount! / 100).toFixed(2)}`;
    hint = `Cobro de ${orig}. Importe estimado en ${acc!.currency} con ${c.own ? 'tu tipo de cambio' : 'un tipo de cambio de referencia'} (${c.rate}): corrígelo con el monto real que cobró tu banco.`;
  }
  // Solo donde la cuenta es una suposición (Gmail): en las notificaciones del teléfono la cuenta la eligió el usuario.
  const ask = Boolean(o.ask_if_unmatched) && matched == null && (await hasSeveralPlaces(db, userId));
  try {
    const r = await createTransaction(db, userId, {
      type: p.type!, amount, occurred_at: p.occurred_at, account_id: accountId, merchant: p.merchant ?? null,
      source: o.source, status: 'pending', needs_review: true, external_id: p.external_id ?? null,
      source_label: `${o.label}${p.bank_state === 'pending' ? ' (pendiente en el banco)' : ''}`.slice(0, 200),
      description: [p.description, hint ? `${p.currency} ${(p.amount! / 100).toFixed(2)}` : null, p.reference ? `Ref. ${p.reference}` : null].filter(Boolean).join(' · ') || null, import_id: o.import_id ?? null,
      account_pending: ask, review_hint: hint,
    } as any);
    return r.duplicate ? { outcome: 'duplicate', tx_id: r.tx.id } : { outcome: 'created', tx_id: r.tx.id, ask_account: ask };
  } catch (e: any) {
    return { outcome: 'ignored', reason: e?.message ?? 'No se pudo registrar' };
  }
}
