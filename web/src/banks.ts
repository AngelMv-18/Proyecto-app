// Catálogo de emisores en Honduras para la apariencia de las tarjetas.
// No se usan logotipos (son marcas registradas): solo colores aproximados de cada marca y su nombre en texto.
// El usuario puede ajustar los colores de cualquier tarjeta.
export type Pattern = 'chevrons' | 'blocks' | 'waves' | 'diagonal' | 'circles' | 'bills' | 'solid';
export type Bank = { code: string; name: string; short: string; colors: string[]; pattern: Pattern; ink?: string; kind: 'bank' | 'wallet' | 'cash' | 'other' };

export const BANKS: Bank[] = [
  { code: 'atlantida', name: 'Banco Atlántida', short: 'ATLÁNTIDA', colors: ['#0033A0', '#0A57D6', '#E31837'], pattern: 'waves', kind: 'bank' },
  { code: 'bac', name: 'BAC Credomatic', short: 'BAC', colors: ['#C8102E', '#E4002B', '#9E0B22'], pattern: 'chevrons', kind: 'bank' },
  { code: 'ficohsa', name: 'Banco Ficohsa', short: 'FICOHSA', colors: ['#0A1F44', '#13407A', '#00A3E0'], pattern: 'diagonal', kind: 'bank' },
  { code: 'banpais', name: 'Banpaís', short: 'BANPAÍS', colors: ['#0B2D6B', '#1BB7D6', '#FDB913'], pattern: 'blocks', kind: 'bank' },
  { code: 'occidente', name: 'Banco de Occidente', short: 'OCCIDENTE', colors: ['#00468B', '#0067B1', '#F2A900'], pattern: 'waves', kind: 'bank' },
  { code: 'davivienda', name: 'Davivienda', short: 'DAVIVIENDA', colors: ['#B5121B', '#E1251B', '#7A0C12'], pattern: 'circles', kind: 'bank' },
  { code: 'lafise', name: 'Banco LAFISE', short: 'LAFISE', colors: ['#005F30', '#00843D', '#7CC242'], pattern: 'diagonal', kind: 'bank' },
  { code: 'banrural', name: 'Banrural', short: 'BANRURAL', colors: ['#00703C', '#009639', '#FFD100'], pattern: 'blocks', kind: 'bank' },
  { code: 'promerica', name: 'Banco Promerica', short: 'PROMERICA', colors: ['#1E5128', '#3F8F2A', '#9BCB3B'], pattern: 'waves', kind: 'bank' },
  { code: 'azteca', name: 'Banco Azteca', short: 'AZTECA', colors: ['#006341', '#00843D', '#A6CE39'], pattern: 'chevrons', kind: 'bank' },
  { code: 'cuscatlan', name: 'Banco Cuscatlán', short: 'CUSCATLÁN', colors: ['#003C7E', '#0057B8', '#00A3E0'], pattern: 'diagonal', kind: 'bank' },
  { code: 'popular', name: 'Banco Popular', short: 'POPULAR', colors: ['#003F87', '#0055A5', '#F7941D'], pattern: 'circles', kind: 'bank' },
  { code: 'ficensa', name: 'Banco FICENSA', short: 'FICENSA', colors: ['#002B55', '#003A70', '#C8A24A'], pattern: 'diagonal', kind: 'bank' },
  { code: 'banhcafe', name: 'Banhcafé', short: 'BANHCAFÉ', colors: ['#4A2E1B', '#6B4426', '#7FA343'], pattern: 'waves', kind: 'bank' },
  { code: 'bantrab', name: 'Banco de los Trabajadores', short: 'BANTRAB', colors: ['#1D428A', '#2856B0', '#C8102E'], pattern: 'blocks', kind: 'bank' },
  { code: 'banhonduras', name: 'Banco de Honduras', short: 'BANCO DE HONDURAS', colors: ['#0B2545', '#13315C', '#8DA9C4'], pattern: 'solid', kind: 'bank' },
  { code: 'tigo_money', name: 'Tigo Money', short: 'TIGO MONEY', colors: ['#00377B', '#0057B8', '#00C8FF'], pattern: 'circles', kind: 'wallet' },
  { code: 'tengo', name: 'TENGO', short: 'TENGO', colors: ['#E85D04', '#F48C06', '#FFBA08'], pattern: 'waves', kind: 'wallet' },
  { code: 'cash', name: 'Efectivo', short: 'EFECTIVO', colors: ['#1B5E3B', '#2E7D4F', '#9CCC65'], pattern: 'bills', kind: 'cash' },
  { code: 'other', name: 'Otro / personalizado', short: '', colors: ['#1A2029', '#2B3442', '#C6FF3D'], pattern: 'diagonal', kind: 'other' },
];

export const bankByCode = (code?: string | null) => BANKS.find((b) => b.code === code);

/** Banco por defecto según el tipo de cuenta, para que toda cuenta tenga apariencia aunque no se elija banco. */
export function designFor(a: { bank_code?: string | null; card_colors?: string | null; type: string; name: string }) {
  const bank = bankByCode(a.bank_code) ?? (a.type === 'cash' ? bankByCode('cash')! : bankByCode('other')!);
  const colors = a.card_colors ? a.card_colors.split(',') : bank.colors;
  const c = [colors[0], colors[1] ?? colors[0], colors[2] ?? colors[1] ?? colors[0]];
  const label = bank.code === 'other' ? a.name.toUpperCase().slice(0, 22) : bank.short;
  return { bank, colors: c, label, pattern: bank.pattern };
}

export const NETWORKS: Record<string, string> = { visa: 'VISA', mastercard: 'Mastercard', amex: 'AMEX', unionpay: 'UnionPay', none: '' };
export const TYPE_BADGE: Record<string, string> = { cash: 'EFECTIVO', bank: 'CUENTA', debit_card: 'DÉBITO', credit_card: 'CRÉDITO', wallet: 'BILLETERA', savings: 'AHORRO', other: 'CUENTA' };
