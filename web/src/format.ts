// Formatos configurables: la moneda, el idioma regional y la zona horaria vienen del perfil del usuario.
export type Fmt = { locale: string; currency: string; timezone: string };
let F: Fmt = { locale: 'es-HN', currency: 'HNL', timezone: 'America/Tegucigalpa' };
export const setFmt = (f: Fmt) => { F = f; };
export const getFmt = () => F;

export const money = (minor: number | null | undefined, currency?: string, opts: { sign?: boolean; compact?: boolean } = {}) => {
  if (minor == null) return '—';
  const cur = currency ?? F.currency;
  const v = minor / 100;
  const s = new Intl.NumberFormat(F.locale, { style: 'currency', currency: cur, currencyDisplay: cur === 'HNL' ? 'code' : 'narrowSymbol', notation: opts.compact ? 'compact' : 'standard', maximumFractionDigits: opts.compact ? 1 : 2 }).format(Math.abs(v)).replace(/ /g, ' ');
  return (v < 0 ? '−' : opts.sign && v > 0 ? '+' : '') + s;
};
export const num = (n: number, d = 0) => new Intl.NumberFormat(F.locale, { maximumFractionDigits: d }).format(n);

export const dateShort = (iso: string | Date) => new Intl.DateTimeFormat(F.locale, { day: '2-digit', month: 'short', timeZone: F.timezone }).format(new Date(iso));
export const dateLong = (iso: string | Date) => new Intl.DateTimeFormat(F.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: F.timezone }).format(new Date(iso));
export const dateTime = (iso: string | Date) => new Intl.DateTimeFormat(F.locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: F.timezone }).format(new Date(iso));
export const dayKey = (iso: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: F.timezone }).format(new Date(iso));
export const ymd = (s: string) => new Intl.DateTimeFormat(F.locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(s + 'T00:00:00Z'));

/** "1,234.50" | "1.234,50" | "120" -> centavos (o null si no es válido) */
export function toMinor(input: string): number | null {
  const s = input.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  const d = s.replace(/-/g, '');
  const lastDot = d.lastIndexOf('.'), lastComma = d.lastIndexOf(',');
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) { const sep = lastDot >= 0 ? '.' : ','; if (d.length - d.lastIndexOf(sep) - 1 <= 2 && d.split(sep).length === 2) dec = sep; }
  const clean = dec ? d.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.') : d.replace(/[.,]/g, '');
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}
export const fromMinor = (m: number | null | undefined) => (m == null ? '' : (m / 100).toFixed(2));
export const isoLocalInput = (d = new Date()) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export const TYPE_LABEL: Record<string, string> = { income: 'Ingreso', expense: 'Gasto', transfer: 'Transferencia', debt_payment: 'Pago de deuda', debt_collection: 'Cobro de deuda', refund: 'Reembolso', adjustment: 'Ajuste de saldo', goal_saving: 'Ahorro a meta' };
export const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', email: 'Detectado por correo', import: 'Importado', notification: 'Detectado por notificación', bank_api: 'Banco' };
export const ACCOUNT_TYPES: Record<string, string> = { cash: 'Efectivo', bank: 'Cuenta bancaria', debit_card: 'Tarjeta de débito', credit_card: 'Tarjeta de crédito', wallet: 'Billetera digital', savings: 'Cuenta de ahorro', other: 'Otra' };
export const NATURE_LABEL: Record<string, string> = { essential: 'Esencial', discretionary: 'Discrecional', extraordinary: 'Extraordinario' };
export const FREQ_LABEL: Record<string, string> = { weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual', yearly: 'Anual' };
export const PAY_METHODS = ['Efectivo', 'Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'Google Pay', 'Billetera digital', 'Otro'];
