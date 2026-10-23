import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, googleConfigured } from '../config.js';
import { one, pool, rows, withTx } from '../db.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { newToken, rateLimit, sha256 } from '../security.js';
import { authUrl, disconnect, gmailStatus, handleCallback, syncGmail } from '../services/gmail.js';
import { parseFinancialMessage } from '../services/parser.js';
import { ingestParsed } from '../services/ingest.js';
import { CsvMapping, guessMapping, importRows, parseCsv, rowsFromCsv, rowsFromOfx } from '../services/importer.js';
import { refreshAlerts } from '../services/alerts.js';
import { getUser } from '../services/stats.js';
import { isAdmin } from '../services/users.js';

const uuid = z.string().uuid();
export async function integrationRoutes(app: FastifyInstance) {
  // Estado honesto de cada método de detección.
  app.get('/api/integrations', async (req) => {
    const g = await one(pool, `SELECT * FROM integrations WHERE user_id=$1 AND provider='gmail'`, [uid(req)]);
    const u = await one(pool, 'SELECT ingest_token_hash, settings FROM users WHERE id=$1', [uid(req)]);
    const imports = await rows(pool, 'SELECT id,kind,filename,total_rows,created_rows,duplicate_rows,skipped_rows,created_at FROM imports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [uid(req)]);
    return {
      gmail: { ...gmailStatus(g), is_admin: await isAdmin(pool, uid(req)), redirect_uris: [`${config.publicUrl}/api/auth/google/callback`, `${config.publicUrl}/api/integrations/gmail/callback`], default_account: g?.config?.default_account_id ? await one(pool, 'SELECT id, name FROM accounts WHERE id=$1 AND user_id=$2', [g.config.default_account_id, uid(req)]) : null },
      notifications: {
        status: u.ingest_token_hash ? 'token_activo' : 'sin_token',
        endpoint: `${config.publicUrl}/api/ingest/notification`,
        ingest_account_id: u.settings?.ingest_account_id ?? null,
        note: 'Una PWA no puede leer notificaciones de otras apps. En Android usa la app complementaria NOVA Captura (acceso a notificaciones y, opcionalmente, SMS, siempre con tu permiso explícito) o una app de automatización como Tasker/MacroDroid que envíe el texto a este endpoint.',
      },
      files: { status: 'disponible', formats: ['CSV', 'OFX/QFX'] },
      bank_api: { status: 'no_disponible', reason: 'No hay una API bancaria pública verificada para los bancos de Honduras ni agregadores con cobertura confirmada. Se habilitará si algún banco o proveedor lo ofrece.' },
      google_pay: { status: 'no_disponible', reason: 'Google Pay/Wallet no ofrece una API pública para que una app lea tus pagos. Las compras con Google Pay se detectan indirectamente por correo, SMS/notificación del banco o extracto.' },
      imports,
    };
  });

  app.post('/api/integrations/gmail/connect', async (req) => ({ url: await authUrl(pool, uid(req)) }));
  // El callback llega desde Google sin cabeceras personalizadas: se valida con el 'state' de un solo uso.
  app.get('/api/integrations/gmail/callback', async (req, reply) => {
    const q = parse(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), req.query);
    if (q.error || !q.code || !q.state) return reply.redirect('/#/integraciones?gmail=cancelado');
    try {
      const userId = await handleCallback(pool, q.code, q.state);
      // Primera revisión inmediata, en segundo plano (la persona no espera en la pantalla de Google).
      syncGmail(pool, userId).then(() => refreshAlerts(pool, userId)).catch(() => {});
      return reply.redirect('/#/integraciones?gmail=ok');
    }
    catch { return reply.redirect('/#/integraciones?gmail=error'); }
  });
  app.put('/api/integrations/gmail/config', async (req) => {
    const b = parse(z.object({ senders: z.array(z.string().trim().min(3).max(120)).max(20), label: z.string().max(60).optional(), default_account_id: uuid.nullable(), query: z.string().max(300).optional() }), req.body);
    if (b.default_account_id && !(await one(pool, 'SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2', [b.default_account_id, uid(req)]))) throw badRequest('Cuenta no válida');
    const r = await pool.query(`UPDATE integrations SET config=$2 WHERE user_id=$1 AND provider='gmail'`, [uid(req), JSON.stringify(b)]);
    if (!r.rowCount) throw new AppError(409, 'not_connected', 'Gmail no está conectado');
    return { ok: true };
  });
  app.patch('/api/integrations/gmail/account', async (req) => {
    const b = parse(z.object({ default_account_id: uuid }), req.body);
    if (!(await one(pool, 'SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2', [b.default_account_id, uid(req)]))) throw badRequest('Cuenta no válida');
    const r = await pool.query(`UPDATE integrations SET config = jsonb_set(COALESCE(config,'{}'::jsonb), '{default_account_id}', to_jsonb($2::text)) WHERE user_id=$1 AND provider='gmail'`, [uid(req), b.default_account_id]);
    if (!r.rowCount) throw new AppError(409, 'not_connected', 'Gmail no está conectado');
    return { ok: true };
  });
  app.post('/api/integrations/gmail/sync', async (req) => {
    await rateLimit(pool, `sync:${uid(req)}`, 6, 60);
    const r = await syncGmail(pool, uid(req));
    try { await refreshAlerts(pool, uid(req)); } catch { /* best-effort */ }
    return r;
  });
  app.delete('/api/integrations/gmail', async (req) => { await disconnect(pool, uid(req)); return { ok: true }; });

  // Token de ingesta para automatizaciones del propio usuario (se muestra una sola vez).
  app.post('/api/integrations/ingest-token', async (req) => {
    const b = parse(z.object({ account_id: uuid.optional() }), req.body);
    const token = `nova_ing_${newToken(24)}`;
    await withTx(async (c) => {
      await c.query('UPDATE users SET ingest_token_hash=$2 WHERE id=$1', [uid(req), sha256(token)]);
      if (b.account_id) {
        if (!(await one(c, 'SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2', [b.account_id, uid(req)]))) throw badRequest('Cuenta no válida');
        await c.query(`UPDATE users SET settings = jsonb_set(settings,'{ingest_account_id}', to_jsonb($2::text)) WHERE id=$1`, [uid(req), b.account_id]);
      }
      await audit(c, uid(req), 'integration', 'ingest', 'token_created');
    });
    return { token, note: 'Guárdalo ahora: no se vuelve a mostrar. Úsalo como "Authorization: Bearer <token>".' };
  });
  app.delete('/api/integrations/ingest-token', async (req) => { await pool.query('UPDATE users SET ingest_token_hash=NULL WHERE id=$1', [uid(req)]); await audit(pool, uid(req), 'integration', 'ingest', 'token_revoked'); return { ok: true }; });

  // Endpoints para la app Android y automatizaciones: autentican con el token de ingesta, no con cookie.
  async function ingestUser(req: any) {
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Bearer nova_ing_')) throw new AppError(401, 'unauthorized', 'Token de ingesta requerido');
    const u = await one(pool, 'SELECT id, settings FROM users WHERE ingest_token_hash=$1', [sha256(h.slice(7))]);
    if (!u) throw new AppError(401, 'unauthorized', 'Token de ingesta inválido');
    return u;
  }
  // Comprobación de conexión desde la app: no registra nada.
  app.post('/api/ingest/ping', async (req) => {
    const u = await ingestUser(req);
    await rateLimit(pool, `ingest:${u.id}`, 60, 60);
    const acc = u.settings?.ingest_account_id ? await one(pool, 'SELECT name, currency FROM accounts WHERE id=$1 AND user_id=$2', [u.settings.ingest_account_id, u.id]) : null;
    return { ok: true, account: acc ? { name: acc.name, currency: acc.currency } : null, note: acc ? undefined : 'Configura la cuenta destino en NOVA → Integraciones' };
  });
  app.post('/api/ingest/notification', async (req) => {
    const u = await ingestUser(req);
    await rateLimit(pool, `ingest:${u.id}`, 60, 60);
    const b = parse(z.object({
      text: z.string().min(3).max(2000), title: z.string().max(200).optional(), app: z.string().max(80).optional(), posted_at: z.string().datetime({ offset: true }).optional(), account_id: uuid.optional(),
      // Identificador estable del aviso en el teléfono: si la app reintenta, no se duplica.
      source_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(), channel: z.enum(['notification', 'sms']).optional(),
    }), req.body);
    const accId = b.account_id ?? u.settings?.ingest_account_id;
    if (!accId) throw badRequest('Configura una cuenta predeterminada para la ingesta', 'no_default_account');
    const parsed = parseFinancialMessage({ subject: b.title, body: b.text, receivedAt: b.posted_at, id: b.source_id ? `dev:${b.source_id}` : undefined });
    const label = `${b.channel === 'sms' ? 'SMS' : 'Notificación'}${b.app ? `: ${b.app}` : ''}`;
    const r = await ingestParsed(pool, u.id, parsed, { account_id: accId, source: 'notification', label });
    try { await refreshAlerts(pool, u.id); } catch { /* best-effort */ }
    return { ...r, parsed: parsed.kind === 'movement' ? { type: parsed.type, amount: parsed.amount, currency: parsed.currency, merchant: parsed.merchant, bank_state: parsed.bank_state, confidence: parsed.confidence } : undefined };
  });

  // ---------- Importación de extractos ----------
  const importBody = z.object({ kind: z.enum(['csv', 'ofx']), content: z.string().min(5).max(3_000_000), filename: z.string().max(120).optional() });
  app.post('/api/import/preview', async (req) => {
    const b = parse(importBody, req.body);
    if (b.kind === 'ofx') { const r = rowsFromOfx(b.content); return { kind: 'ofx', rows: r.rows.slice(0, 10), total: r.rows.length, errors: r.errors.slice(0, 10), currency: r.currency ?? null }; }
    const table = parseCsv(b.content);
    if (table.length < 2) throw badRequest('El archivo no tiene filas de datos');
    const mapping = guessMapping(table[0]);
    const r = rowsFromCsv(table, mapping);
    return { kind: 'csv', header: table[0], sample: table.slice(1, 6), mapping, rows: r.rows.slice(0, 10), total: r.rows.length, errors: r.errors.slice(0, 10) };
  });
  app.post('/api/import/commit', async (req) => {
    const b = importBody.extend({
      account_id: uuid,
      mapping: z.object({ date: z.number().int(), description: z.number().int(), amount: z.number().int().optional(), debit: z.number().int().optional(), credit: z.number().int().optional(), reference: z.number().int().optional(), dayFirst: z.boolean().optional(), hasHeader: z.boolean().optional() }).optional(),
    }).parse(req.body);
    const u = await getUser(pool, uid(req));
    let raw, errors: string[];
    if (b.kind === 'ofx') ({ rows: raw, errors } = rowsFromOfx(b.content));
    else { const table = parseCsv(b.content); ({ rows: raw, errors } = rowsFromCsv(table, (b.mapping as CsvMapping) ?? guessMapping(table[0]))); }
    if (!raw.length) throw badRequest(`No se pudo leer ningún movimiento. ${errors[0] ?? ''}`, 'empty_import');
    const imp = await withTx((c) => importRows(c, uid(req), b.account_id, b.kind, b.filename ?? null, raw, u.timezone));
    try { await refreshAlerts(pool, uid(req)); } catch { /* best-effort */ }
    return { ...imp, parse_errors: errors.slice(0, 10) };
  });
}
