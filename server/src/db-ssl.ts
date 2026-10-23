import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

/**
 * TLS hacia la base de datos. Con Supabase (o DATABASE_SSL=require) se verifica el certificado del servidor contra
 * las raíces públicas + la CA raíz de Supabase incluida en server/certs. La verificación nunca se desactiva.
 */
export function sslFor(url: string) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const wanted = process.env.DATABASE_SSL ?? (/\.supabase\.(co|com)$/.test(host) ? 'require' : 'off');
  if (wanted === 'off') return undefined;
  const caFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'supabase-root-2021.crt');
  const extra = process.env.DATABASE_CA ? [process.env.DATABASE_CA] : [readFileSync(caFile, 'utf8')];
  return { rejectUnauthorized: true, ca: [...rootCertificates, ...extra] };
}
