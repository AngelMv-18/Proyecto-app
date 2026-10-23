import { createHash } from 'node:crypto';
import { Db, one } from '../db.js';
import { badRequest } from '../errors.js';
import { createTransaction } from './ledger.js';
import { audit } from '../audit.js';

export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const out: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) out.push(row.map((x) => x.trim())); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) out.push(row.map((x) => x.trim()));
  return out;
}

export type RawRow = { date: string; amount: number; description: string; reference?: string | null };

/** Fecha dd/mm/yyyy (formato habitual en Honduras), yyyy-mm-dd o yyyymmdd. */
export function parseDate(s: string, dayFirst = true): string | null {
  const v = s.trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

export function signedAmount(s: string): number | null {
  const neg = /^\(.*\)$/.test(s.trim()) || /^-/.test(s.trim()) || /-$/.test(s.trim());
  const digits = s.replace(/[^0-9.,]/g, '');
  if (!digits) return null;
  const lastDot = digits.lastIndexOf('.'), lastComma = digits.lastIndexOf(',');
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) { const sep = lastDot >= 0 ? '.' : ','; if (digits.length - digits.lastIndexOf(sep) - 1 <= 2 && digits.split(sep).length === 2) dec = sep; }
  const clean = dec ? digits.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.') : digits.replace(/[.,]/g, '');
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

export type CsvMapping = { date: number; description: number; amount?: number; debit?: number; credit?: number; reference?: number; dayFirst?: boolean; hasHeader?: boolean };

/** Sugiere columnas a partir de encabezados comunes de extractos bancarios en español. */
export function guessMapping(header: string[]): CsvMapping {
  const find = (re: RegExp) => header.findIndex((h) => re.test(h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()));
  const m: CsvMapping = { date: find(/fecha|date/), description: find(/descripcion|detalle|concepto|description|memo|comercio/), hasHeader: true, dayFirst: true };
  const amount = find(/^(monto|importe|amount|valor)$/), debit = find(/debito|cargo|retiro|debit/), credit = find(/credito|abono|deposito|credit/);
  if (amount >= 0) m.amount = amount; else { m.debit = debit; m.credit = credit; }
  const ref = find(/referencia|reference|documento|numero|no\./); if (ref >= 0) m.reference = ref;
  return m;
}

export function rowsFromCsv(table: string[][], map: CsvMapping): { rows: RawRow[]; errors: string[] } {
  const body = map.hasHeader === false ? table : table.slice(1);
  const rows: RawRow[] = [], errors: string[] = [];
  body.forEach((r, i) => {
    const line = i + (map.hasHeader === false ? 1 : 2);
    const date = parseDate(r[map.date] ?? '', map.dayFirst !== false);
    let amount: number | null = null;
    if (map.amount != null && map.amount >= 0) amount = signedAmount(r[map.amount] ?? '');
    else {
      const d = map.debit != null && map.debit >= 0 && r[map.debit] ? signedAmount(r[map.debit]) : null;
      const c = map.credit != null && map.credit >= 0 && r[map.credit] ? signedAmount(r[map.credit]) : null;
      amount = c ? Math.abs(c) : d ? -Math.abs(d) : null;
    }
    if (!date || amount == null || amount === 0) { errors.push(`Fila ${line}: fecha o importe no válidos`); return; }
    rows.push({ date, amount, description: (r[map.description] ?? '').slice(0, 200), reference: map.reference != null && map.reference >= 0 ? r[map.reference] || null : null });
  });
  return { rows, errors };
}

/** OFX/QFX (SGML o XML): lee STMTTRN con FITID, DTPOSTED, TRNAMT, NAME/MEMO. */
export function rowsFromOfx(text: string): { rows: RawRow[]; errors: string[]; currency?: string } {
  const rows: RawRow[] = [], errors: string[] = [];
  const cur = text.match(/<CURDEF>\s*([A-Z]{3})/i)?.[1]?.toUpperCase();
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const b of blocks) {
    const tag = (n: string) => b.match(new RegExp(`<${n}>\\s*([^<\\r\\n]*)`, 'i'))?.[1]?.trim();
    const dt = tag('DTPOSTED'), amt = tag('TRNAMT');
    const date = dt ? parseDate(dt.slice(0, 8)) : null;
    const n = amt ? Number(amt.replace(',', '.')) : NaN;
    if (!date || !Number.isFinite(n) || n === 0) { errors.push(`Transacción OFX inválida (${tag('FITID') ?? 'sin FITID'})`); continue; }
    rows.push({ date, amount: Math.round(n * 100), description: [tag('NAME'), tag('MEMO')].filter(Boolean).join(' · ').slice(0, 200), reference: tag('FITID') ?? null });
  }
  return { rows, errors, currency: cur };
}

/** Importa filas como movimientos PENDIENTES de revisión; nunca altera saldos hasta confirmarlos. */
export async function importRows(db: Db, userId: string, accountId: string, kind: 'csv' | 'ofx', filename: string | null, raw: RawRow[], tz: string) {
  const acc = await one(db, 'SELECT * FROM accounts WHERE id=$1 AND user_id=$2', [accountId, userId]);
  if (!acc) throw badRequest('Cuenta no válida', 'invalid_account');
  const imp = await one(db, `INSERT INTO imports(user_id,kind,filename,account_id,total_rows) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [userId, kind, filename, accountId, raw.length]);
  let created = 0, duplicate = 0, skipped = 0;
  const seen = new Map<string, number>();
  for (const r of raw) {
    const base = r.reference ? `ofx:${accountId}:${r.reference}` : `csv:${accountId}:${r.date}|${r.amount}|${r.description}`;
    // Filas idénticas dentro del mismo archivo (dos cafés el mismo día) se distinguen por su ocurrencia.
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    const external_id = createHash('sha256').update(`${base}#${n}`).digest('hex').slice(0, 40);
    try {
      const res = await createTransaction(db, userId, {
        type: r.amount > 0 ? 'income' : 'expense', amount: Math.abs(r.amount), account_id: accountId,
        occurred_at: new Date(`${r.date}T12:00:00-06:00`).toISOString(), merchant: r.description || null, description: r.description || null,
        source: 'import', status: 'pending', needs_review: true, external_id, source_label: `Importado${filename ? `: ${filename}` : ''}`, import_id: imp.id,
      });
      if (res.duplicate) duplicate++; else created++;
    } catch (e: any) {
      skipped++; // p. ej. fecha anterior al saldo inicial
    }
  }
  const upd = await one(db, `UPDATE imports SET created_rows=$2, duplicate_rows=$3, skipped_rows=$4 WHERE id=$1 RETURNING *`, [imp.id, created, duplicate, skipped]);
  await audit(db, userId, 'import', imp.id, 'create', null, { kind, filename, created, duplicate, skipped });
  return upd;
}
