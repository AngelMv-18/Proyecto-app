import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, rows, withTx } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { verifyPassword } from '../security.js';

// Orden respetando claves foráneas. Las tablas con auto-referencias se insertan por pasos.
const TABLES = ['categories', 'accounts', 'goals', 'debts', 'recurring', 'imports', 'transactions', 'receipts', 'budgets', 'reconciliations', 'notifications'] as const;
const DELETE_ORDER = ['reconciliations', 'receipts', 'budgets', 'notifications', 'transactions', 'recurring', 'imports', 'goals', 'debts', 'accounts', 'categories', 'integrations'];

async function requirePassword(userId: string, password: string) {
  const u = await one(pool, 'SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (!u || !(await verifyPassword(password, u.password_hash))) throw new AppError(403, 'wrong_password', 'Contraseña incorrecta');
}

async function insertRows(c: any, table: string, userId: string, items: any[]) {
  if (!items.length) return;
  const cols: string[] = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND table_schema='public'`, [table])).rows.map((r: any) => r.column_name);
  for (const it of items) {
    const keys = Object.keys(it).filter((k) => cols.includes(k));
    const vals = keys.map((k) => {
      if (k === 'user_id') return userId;
      const v = it[k];
      if (table === 'receipts' && k === 'data') return Buffer.from(v, 'base64');
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    await c.query(`INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  }
}

export async function dataRoutes(app: FastifyInstance) {
  // Exportación completa (respaldo portátil). Excluye hashes, tokens de sesión y tokens OAuth.
  app.get('/api/data/export', async (req, reply) => {
    const id = uid(req);
    const out: any = { app: 'nova-finance', version: 1, exported_at: new Date().toISOString() };
    const u = await one(pool, 'SELECT email, display_name, currency, timezone, locale, settings FROM users WHERE id=$1', [id]);
    out.user = u;
    for (const t of TABLES) {
      if (t === 'receipts') out[t] = (await rows(pool, `SELECT transaction_id, mime, encode(data,'base64') AS data FROM receipts WHERE user_id=$1`, [id]));
      else out[t] = await rows(pool, `SELECT * FROM ${t} WHERE user_id=$1`, [id]);
    }
    out.audit_log = await rows(pool, 'SELECT entity, entity_id, action, before, after, detail, created_at FROM audit_log WHERE user_id=$1 ORDER BY id', [id]);
    await audit(pool, id, 'data', null, 'export');
    reply.header('content-type', 'application/json').header('content-disposition', `attachment; filename="nova-respaldo-${new Date().toISOString().slice(0, 10)}.json"`);
    return JSON.stringify(out);
  });

  // Restauración: reemplaza TODOS los datos financieros del usuario por los del respaldo, de forma atómica.
  app.post('/api/data/restore', async (req) => {
    const b = parse(z.object({ password: z.string().min(1), confirm: z.literal('RESTAURAR'), data: z.record(z.any()) }), req.body);
    const id = uid(req);
    await requirePassword(id, b.password);
    const d = b.data;
    if (d.app !== 'nova-finance' || d.version !== 1) throw badRequest('El archivo no es un respaldo válido de NOVA FINANCE');
    for (const t of TABLES) if (d[t] !== undefined && !Array.isArray(d[t])) throw badRequest(`Respaldo corrupto: ${t}`);
    await withTx(async (c) => {
      for (const t of DELETE_ORDER) await c.query(`DELETE FROM ${t} WHERE user_id=$1`, [id]);
      const cats = d.categories ?? [];
      await insertRows(c, 'categories', id, cats.filter((x: any) => !x.parent_id)); await insertRows(c, 'categories', id, cats.filter((x: any) => x.parent_id));
      await insertRows(c, 'accounts', id, d.accounts ?? []);
      await insertRows(c, 'goals', id, d.goals ?? []);
      await insertRows(c, 'debts', id, d.debts ?? []);
      await insertRows(c, 'recurring', id, d.recurring ?? []);
      await insertRows(c, 'imports', id, d.imports ?? []);
      const tx = d.transactions ?? [];
      await insertRows(c, 'transactions', id, tx.filter((x: any) => !x.refund_of)); await insertRows(c, 'transactions', id, tx.filter((x: any) => x.refund_of));
      await insertRows(c, 'receipts', id, (d.receipts ?? []).map((r: any) => ({ ...r, user_id: id })));
      await insertRows(c, 'budgets', id, d.budgets ?? []);
      await insertRows(c, 'reconciliations', id, d.reconciliations ?? []);
      await insertRows(c, 'notifications', id, d.notifications ?? []);
      if (d.user?.settings) await c.query('UPDATE users SET settings=$2 WHERE id=$1', [id, JSON.stringify(d.user.settings)]);
      await audit(c, id, 'data', null, 'restore', null, { transactions: tx.length, accounts: (d.accounts ?? []).length });
    });
    return { ok: true, transactions: (d.transactions ?? []).length, accounts: (d.accounts ?? []).length };
  });

  // Borra todos los datos financieros (conserva el usuario).
  app.post('/api/data/wipe', async (req) => {
    const b = parse(z.object({ password: z.string().min(1), confirm: z.literal('ELIMINAR') }), req.body);
    await requirePassword(uid(req), b.password);
    await withTx(async (c) => {
      for (const t of DELETE_ORDER) await c.query(`DELETE FROM ${t} WHERE user_id=$1`, [uid(req)]);
      await audit(c, uid(req), 'data', null, 'wipe');
    });
    return { ok: true };
  });

  // Elimina la cuenta de usuario y todo lo asociado.
  app.post('/api/data/delete-account', async (req, reply) => {
    const b = parse(z.object({ password: z.string().min(1), confirm: z.literal('ELIMINAR MI CUENTA') }), req.body);
    await requirePassword(uid(req), b.password);
    await pool.query('DELETE FROM users WHERE id=$1', [uid(req)]);
    reply.clearCookie('nova_session', { path: '/' });
    return { ok: true };
  });
}
