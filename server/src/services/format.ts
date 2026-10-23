export function fmtMoney(minor: number, currency = 'HNL', locale = 'es-HN') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: currency === 'HNL' ? 'code' : 'symbol' }).format(minor / 100);
}
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const clamp = (x: number, lo = 0, hi = 1) => Math.min(Math.max(x, lo), hi);
