import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { startScheduler } from './services/scheduler.js';

await migrate();
const app = await buildApp();
// Limpieza periódica de sesiones vencidas.
setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 6 * 3600_000).unref();
startScheduler();
await app.listen({ port: config.port, host: config.host });
if (config.isProd && !config.encryptionKey) app.log.warn('APP_ENCRYPTION_KEY no definida: la integración con Gmail permanecerá desactivada');
