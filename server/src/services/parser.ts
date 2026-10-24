import { createHash } from 'node:crypto';

export type ParsedMessage = {
  kind: 'movement' | 'ignored';
  reason?: string;
  bank_state?: 'approved' | 'pending';
  type?: 'expense' | 'income';
  amount?: number; // unidades menores
  currency?: string;
  merchant?: string | null;
  reference?: string | null;
  occurred_at?: string;
  card_last4?: string | null;
  bank?: string | null; // código del banco emisor (ver web/src/banks.ts), si se reconoce
  description?: string | null;
  confidence?: 'alta' | 'media' | 'baja';
  external_id?: string | null;
};

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|td|th|li|table|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n\s*\n+/g, '\n').trim();
}

/** "1,234.56" | "1.234,56" | "1234,5" | "1,234" -> unidades menores */
export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const after = s.length - s.lastIndexOf(sep) - 1;
    const count = s.split(sep).length - 1;
    if (after <= 2 && count === 1) dec = sep; // un solo separador con 1-2 dígitos: decimal
  }
  const clean = dec ? s.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.') : s.replace(/[.,]/g, '');
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

const CUR_PRE = /(?:^|[^a-z0-9])(l\.?|lps?\.?|hnl|us\$|usd|\$|eur|€)\s*([0-9][0-9.,]*)/gi;
const CUR_POST = /([0-9][0-9.,]*)\s*(hnl|usd|lempiras?|dolares?|lps?\b)/gi;
const curOf = (t: string) => {
  const c = strip(t).replace(/\./g, '');
  if (['l', 'lp', 'lps', 'hnl', 'lempira', 'lempiras'].includes(c)) return 'HNL';
  if (['us$', 'usd', '$', 'dolar', 'dolares'].includes(c)) return 'USD';
  if (['eur', '€'].includes(c)) return 'EUR';
  return 'HNL';
};

const DECLINED = /(rechazad|declinad|denegad|no autorizad|no fue autorizad|cancelad|anulad|fallid|no pudo (?:ser )?proces|sin fondos|fondos insuficientes|reverso|reversad)/;
const PENDING = /(pendiente|en proceso|en transito|por autorizar|preautoriz|retenid|en revision)/;
const NOISE = /(promocion|oferta|descuento|cupon|sorteo|te invitamos|aprovecha|newsletter|encuesta|estado de cuenta (?:esta )?disponible|actualiza tus datos)/;
const SECRET = /(codigo de (?:verificacion|seguridad|acceso)|\botp\b|clave (?:temporal|dinamica)|contrasena|password|token de|pin\b)/;
const INCOME_KW = /(deposito|acreditad|abono|recibiste|has recibido|monto recibido|transferencia recibida|credito a (?:su|tu) cuenta|pago recibido)/;
const EXPENSE_KW = /(compra|consumo|pagaste|pago de|pago a|pago realizado|debito|retiro|cargo|transferencia (?:enviada|realizada|exitosa)|enviaste|uso de (?:su|tu) tarjeta|transaccion)/;

// Bancos de Honduras reconocibles en el texto del aviso (código = el de web/src/banks.ts).
const BANKS: [RegExp, string][] = [
  [/credomatic|\bbac\b/, 'bac'], [/atlantida/, 'atlantida'], [/ficohsa/, 'ficohsa'], [/banpais/, 'banpais'], [/banco de occidente/, 'occidente'],
  [/davivienda/, 'davivienda'], [/lafise/, 'lafise'], [/banrural/, 'banrural'], [/promerica/, 'promerica'], [/banco azteca/, 'azteca'],
  [/cuscatlan/, 'cuscatlan'], [/banco popular/, 'popular'], [/ficensa/, 'ficensa'], [/banhcafe/, 'banhcafe'], [/bantrab/, 'bantrab'],
  [/tigo money/, 'tigo_money'], [/\btengo\b/, 'tengo'],
];

// Muchos avisos (p. ej. BAC) vienen como tabla: una fila de etiquetas y debajo sus valores, o "Etiqueta" y su valor en la línea siguiente.
const LABELS: Record<string, 'merchant' | 'amount' | 'date' | 'reference'> = {
  comercio: 'merchant', establecimiento: 'merchant', beneficiario: 'merchant', destinatario: 'merchant', 'lugar': 'merchant',
  monto: 'amount', 'monto enviado': 'amount', 'monto recibido': 'amount', importe: 'amount', valor: 'amount', total: 'amount',
  horario: 'date', fecha: 'date', 'fecha y hora': 'date', hora: 'date',
  autorizacion: 'reference', 'numero de autorizacion': 'reference', referencia: 'reference', 'numero de referencia': 'reference',
};
function tableFields(body: string) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  type Field = (typeof LABELS)[string];
  const out: Partial<Record<Field, string>> = {};
  const key = (l: string): Field | undefined => LABELS[strip(l).replace(/[:.]$/, '').trim()];
  for (let i = 0; i < lines.length; i++) {
    const run: Field[] = [];
    let j = i;
    while (j < lines.length && key(lines[j])) run.push(key(lines[j++])!);
    if (!run.length) continue;
    run.forEach((k, n) => { const v = lines[j + n]; if (v && !key(v) && !out[k]) out[k] = v; });
    i = j + run.length - 1;
  }
  return out;
}

function parseDate(text: string): string | null {
  // AAAA/MM/DD[-HH:MM] (BAC tarjetas) o DD/MM/AAAA [a las HH:MM]
  const ymd = text.match(/\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[\sT-]+(\d{1,2}):(\d{2}))?/);
  const dmy = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(?:a las\s+)?(\d{1,2}):(\d{2}))?/);
  const parts = ymd ? [ymd[3], ymd[2], ymd[1], ymd[4], ymd[5]] : dmy ? [dmy[1], dmy[2], dmy[3], dmy[4], dmy[5]] : null;
  if (!parts) return null;
  const [d, mo, y, hh, mm] = parts;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  // Hora de Honduras (UTC-6, sin horario de verano) cuando el mensaje la indica.
  const iso = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(hh ?? '12').padStart(2, '0')}:${mm ?? '00'}:00-06:00`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

export function parseFinancialMessage(input: { subject?: string; body: string; from?: string; receivedAt?: string; id?: string }): ParsedMessage {
  const raw = `${input.subject ?? ''}\n${input.body}`;
  const text = raw.replace(/\s+/g, ' ');
  const t = strip(text);

  if (SECRET.test(t)) return { kind: 'ignored', reason: 'Contiene códigos o claves: se descarta sin procesar' };
  if (DECLINED.test(t)) return { kind: 'ignored', reason: 'Transacción rechazada, cancelada o revertida: no se registra como gasto' };

  // Candidatos de importe (se ignoran los precedidos por "saldo").
  const cands: { value: number; currency: string; ctx: string; idx: number }[] = [];
  for (const m of text.matchAll(CUR_PRE)) {
    const v = parseAmount(m[2].replace(/[.,]$/, ''));
    if (v) cands.push({ value: v, currency: curOf(m[1]), ctx: strip(text.slice(Math.max(0, m.index! - 28), m.index!)), idx: m.index! });
  }
  for (const m of text.matchAll(CUR_POST)) {
    const v = parseAmount(m[1].replace(/[.,]$/, ''));
    if (v && !cands.some((c) => Math.abs(c.idx - m.index!) < 3)) cands.push({ value: v, currency: curOf(m[2]), ctx: strip(text.slice(Math.max(0, m.index! - 28), m.index!)), idx: m.index! });
  }
  const usable = cands.filter((c) => !/(saldo|disponible|limite|credito disponible)\s*(?:actual|total|disponible)?\s*(?:de|:)?\s*$/.test(c.ctx));
  if (!usable.length) return { kind: 'ignored', reason: 'No se identificó un importe: se trata como aviso informativo' };
  const tf = tableFields(input.body);
  const tableAmt = (() => {
    const m = tf.amount?.match(/([0-9][0-9.,]*)/);
    const v = m ? parseAmount(m[1].replace(/[.,]$/, '')) : null;
    if (!v) return undefined;
    const cm = tf.amount!.match(/(us\$|usd|\$|d[oó]lares?|eur|€|lps?\b|hnl|lempiras?|\bl\b)/i);
    return { value: v, currency: cm ? curOf(cm[1]) : 'HNL', ctx: '', idx: -1 };
  })();
  const pref = tableAmt ?? usable.find((c) => /(monto|importe|valor|total|por|compra|consumo|pago|retiro|deposito|abono)\s*(?:de|:)?\s*$/.test(c.ctx)) ?? usable[0];

  const isIncome = INCOME_KW.test(t);
  const isExpense = EXPENSE_KW.test(t);
  const strong = /(aprobad|se realizo|se ha realizado|realizad[ao]|pagaste|enviaste|recibiste|acreditad|deposito|retiro|cargo|debito|consumo de)/.test(t) || /(referencia|autorizacion)\s*[:#]?\s*[a-z0-9]{4}/.test(t);
  if (NOISE.test(t) && !strong) return { kind: 'ignored', reason: 'Parece publicidad o aviso general' };
  if (!isIncome && !isExpense) return { kind: 'ignored', reason: 'No se reconoce como movimiento (compra, pago, depósito...)' };
  const type: 'income' | 'expense' = isIncome && !/(compra|consumo|pagaste|enviaste|retiro)/.test(t) ? 'income' : isExpense ? 'expense' : 'income';

  const merchantM = tf.merchant ? null : text.match(/(?:\ben\b|comercio:?|establecimiento:?|a favor de|beneficiario:?|\ba\b)\s+([A-Za-z0-9ÁÉÍÓÚÑáéíóúñ&.'*\- ]{3,40}?)(?=\s+(?:por|el|con|a las|fecha|monto|hora|usando|terminada|el dia)\b|[,.;\n]|$)/i);
  let merchant = tf.merchant ? tf.merchant.replace(/\s+/g, ' ').slice(0, 80) : merchantM ? merchantM[1].trim().replace(/\s+/g, ' ') : null;
  // Capturas que no son un comercio ("en su cuenta", "a continuación"...).
  if (merchant && /^(su|tu|sus|tus|la|el|los|las|un|una|continuacion|cuenta|tarjeta|lps?|hnl|usd)\b/.test(strip(merchant))) merchant = null;
  const refM = tf.reference ? [null, tf.reference.replace(/\s+/g, '')] as const : text.match(/(?:referencia|ref\.?|autorizaci[oó]n|aprobaci[oó]n|n[úu]mero de (?:transacci[oó]n|operaci[oó]n)|no\.? (?:de )?(?:transacci[oó]n|operaci[oó]n))\s*[:#]?\s*([A-Z0-9-]{4,24})/i);
  const reference = refM ? refM[1].toUpperCase() : null;
  const cardM = t.match(/(?:terminad[ao]s? en|termina en|\*{2,}|x{2,}|(?:visa|mastercard|master card|amex|american express|tarjeta)\s+(?:no\.?\s*)?)\s*(\d{4})\b/);
  const bank = BANKS.find(([re]) => re.test(t))?.[1] ?? null;

  const occurred = (tf.date && parseDate(tf.date)) || parseDate(text) || input.receivedAt || new Date().toISOString();
  // Sin comercio (p. ej. "transacción en su cuenta ****6480"): se describe el movimiento para que se reconozca en Revisión.
  const description = merchant ? null : [
    /monto enviado|transferencia (?:enviada|realizada)|enviaste/.test(t) ? 'Envío / transferencia' : type === 'income' ? 'Depósito / abono' : 'Transacción',
    cardM ? `${/tarjeta|visa|mastercard|amex/.test(t) && !/en su cuenta|en tu cuenta/.test(t) ? 'tarjeta' : 'cuenta'} ****${cardM[1]}` : null,
  ].filter(Boolean).join(' · ');

  const external = reference
    ? `ref:${pref.currency}:${pref.value}:${reference}`
    : input.id ? `msg:${input.id}` : `txt:${createHash('sha256').update(`${pref.value}|${merchant}|${occurred.slice(0, 13)}`).digest('hex').slice(0, 24)}`;

  return {
    kind: 'movement', type, amount: pref.value, currency: pref.currency, merchant, reference, occurred_at: occurred, card_last4: cardM?.[1] ?? null, bank, description,
    bank_state: PENDING.test(t) ? 'pending' : 'approved',
    confidence: merchant && reference ? 'alta' : merchant || reference ? 'media' : 'baja',
    external_id: external,
  };
}
