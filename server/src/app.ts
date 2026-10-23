import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { one, pool } from './db.js';
import { AppError } from './errors.js';
import { sha256 } from './security.js';
import { zodToApp } from './http.js';
import { authRoutes } from './routes/auth.js';
import { financeRoutes } from './routes/finance.js';
import { insightRoutes } from './routes/insights.js';
import { integrationRoutes } from './routes/integrations.js';
import { dataRoutes } from './routes/data.js';
import { notifyRoutes } from './routes/notify.js';
import { lockRoutes, lockPrefs } from './routes/lock.js';
import { brandRoutes } from './routes/brand.js';

// Rutas permitidas con la sesión BLOQUEADA (para mostrar y resolver la pantalla de huella).
const LOCK_EXEMPT = new Set(['/api/lock/status', '/api/lock/unlock/options', '/api/lock/unlock/verify', '/api/lock/unlock/password', '/api/auth/logout', '/api/appearance']);
// Rutas que no requieren sesión de cookie.
const PUBLIC = new Set(['/api/appearance', '/api/health', '/api/auth/status', '/api/auth/register', '/api/auth/login', '/api/auth/login/2fa', '/api/integrations/gmail/callback', '/api/ingest/notification', '/api/ingest/ping']);

export async function buildApp() {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
    logger: config.isTest ? false : {
      level: 'info',
      // Los registros técnicos no incluyen cuerpos, cookies ni la query (puede contener texto de búsqueda financiero).
      serializers: { req: (r) => ({ method: r.method, path: (r.url ?? '').split('?')[0] }), res: (r) => ({ status: r.statusCode }) },
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { parseAs: 'buffer', bodyLimit: 3 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.decorateRequest('userId', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    reply.header('cache-control', 'no-store');
    if (!path.startsWith('/api/')) return;
    // CSRF: las mutaciones exigen cabecera personalizada (no enviable por formularios cross-site) y origen coherente.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !path.startsWith('/api/ingest/')) {
      if (req.headers['x-requested-with'] !== 'nova') throw new AppError(403, 'csrf', 'Solicitud rechazada (falta cabecera de seguridad)');
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        const okOrigin = (() => { try { return new URL(origin).host === host; } catch { return false; } })() || config.allowedOrigins.includes(origin);
        if (!okOrigin) throw new AppError(403, 'csrf', 'Origen no permitido');
      }
    }
    const token = req.cookies.nova_session;
    if (PUBLIC.has(path)) {
      // Rutas públicas que se benefician de conocer al usuario si hay sesión (p. ej. si es administrador).
      if (path === '/api/appearance' && token) { const s0 = await one(pool, 'SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(token)]); req.userId = s0?.user_id ?? null; }
      return;
    }
    const s = token ? await one(pool, 'SELECT s.user_id, s.unlocked_until, u.settings FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()', [sha256(token)]) : null;
    if (!s) throw new AppError(401, 'unauthorized', 'Inicia sesión para continuar');
    req.userId = s.user_id;
    // Bloqueo con huella exigido en el servidor: sin desbloqueo reciente no se entregan datos (423).
    const lock = lockPrefs(s.settings);
    if (lock.enabled && !LOCK_EXEMPT.has(path)) {
      if (!s.unlocked_until || new Date(s.unlocked_until) <= new Date()) throw new AppError(423, 'locked', 'La app está bloqueada');
      // Cada uso renueva el tiempo de desbloqueo (como el bloqueo automático del teléfono).
      if (new Date(s.unlocked_until).getTime() - Date.now() < lock.timeout_min * 60_000 - 20_000) {
        await pool.query(`UPDATE sessions SET unlocked_until = now() + make_interval(mins => $2) WHERE token_hash=$1`, [sha256(token!), lock.timeout_min]);
      }
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) err = zodToApp(err);
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, fields: err.fields } });
    if (err.code === '23505') return reply.code(409).send({ error: { code: 'duplicate', message: 'El registro ya existe' } });
    if (err.code === '23503') return reply.code(409).send({ error: { code: 'in_use', message: 'No se puede completar: hay datos relacionados' } });
    if (err.code === '23514') return reply.code(400).send({ error: { code: 'validation', message: 'Datos no válidos para esta operación' } });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) return reply.code(413).send({ error: { code: 'too_large', message: 'El archivo es demasiado grande' } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: 'Solicitud no válida' } });
    req.log.error({ err: { message: err.message, code: err.code } }, 'error interno');
    return reply.code(500).send({ error: { code: 'internal', message: 'Ocurrió un error interno. Intenta de nuevo.' } });
  });

  app.get('/api/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  await app.register(authRoutes);
  await app.register(financeRoutes);
  await app.register(insightRoutes);
  await app.register(integrationRoutes);
  await app.register(dataRoutes);
  await app.register(notifyRoutes);
  await app.register(lockRoutes);
  await app.register(brandRoutes);

  // Interfaz web compilada (despliegue de un solo proceso).
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, cacheControl: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
