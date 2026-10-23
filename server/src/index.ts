import pg from 'pg';

/**
 * DATABASE_URL puede traer varias URLs separadas por espacios (p. ej. dos hosts posibles del pooler de Supabase):
 * se usa la primera que acepte la conexión. Así el despliegue no depende de adivinar el host exacto.
 */
async function pickDatabaseUrl() {
  const candidates = (process.env.DATABASE_URL ?? '').split(/\s+/).filter(Boolean);
  if (candidates.length <= 1) return;
  const { sslFor } = await import('./db-ssl.js');
  for (const url of candidates) {
    const c = new pg.Client({ connectionString: url, ssl: sslFor(url), connectionTimeoutMillis: 8000 });
    try { await c.connect(); await c.query('SELECT 1'); await c.end(); process.env.DATABASE_URL = url; console.log(`Base de datos: usando ${new URL(url).hostname}`); return; }
    catch (e: any) { console.warn(`Base de datos: ${new URL(url).hostname} no disponible (${e?.code ?? e?.message})`); await c.end().catch(() => {}); }
  }
  throw new Error('Ninguna DATABASE_URL respondió');
}

await pickDatabaseUrl();
const { buildApp } = await import('./app.js');
const { config } = await import('./config.js');
const { migrate } = await import('./migrate.js');
const { pool } = await import('./db.js');
const { startScheduler } = await import('./services/scheduler.js');

await migrate();
const app = await buildApp();
// Limpieza periódica de sesiones vencidas.
setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 6 * 3600_000).unref();
startScheduler();
await app.listen({ port: config.port, host: config.host });
if (config.isProd && !config.encryptionKey) app.log.warn('APP_ENCRYPTION_KEY no definida: la integración con Gmail permanecerá desactivada');
