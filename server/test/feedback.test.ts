import { afterAll, describe, expect, it } from 'vitest';
import { Client, closeApp, getApp, newUser } from './helpers.js';
import { pool } from '../src/db.js';

afterAll(closeApp);

async function adminClient() {
  const first = (await pool.query('SELECT email FROM users ORDER BY created_at, id LIMIT 1')).rows[0];
  if (!first) return newUser();
  const c = new Client(await getApp());
  await c.ok(c.post('/api/auth/login', { email: first.email, password: 'clave-segura-123' }));
  return c;
}

describe('comentarios de la etapa de prueba', () => {
  it('un usuario envía un comentario, el administrador lo ve, responde y la persona recibe el aviso', async () => {
    const admin = await adminClient();
    const tester = await newUser();
    const f = await tester.ok(tester.post('/api/feedback', { kind: 'problem', message: 'Al guardar un gasto con BAC me salió un error', rating: 4, screen: '/movimientos', device: 'Android · 390×844' }));
    // El usuario solo ve lo suyo
    const mine = await tester.ok(tester.get('/api/feedback'));
    expect(mine.is_admin).toBe(false);
    expect(mine.items.map((x: any) => x.id)).toEqual([f.id]);
    expect((await tester.patch(`/api/feedback/${f.id}`, { status: 'done' })).status).toBe(403);
    // Otro usuario no lo ve
    const other = await newUser();
    expect((await other.ok(other.get('/api/feedback'))).items).toEqual([]);
    // El administrador lo ve con autor y recibió un aviso
    const inbox = await admin.ok(admin.get('/api/feedback'));
    expect(inbox.is_admin).toBe(true);
    expect(inbox.items.find((x: any) => x.id === f.id)).toMatchObject({ author: 'Tester', status: 'new', rating: 4, screen: '/movimientos' });
    const an = await admin.ok(admin.get('/api/notifications'));
    expect(an.some((n: any) => n.dedupe_key === `feedback:${f.id}` && n.data.route === '/comentarios')).toBe(true);
    // Responde: la persona ve la respuesta y un aviso
    await admin.ok(admin.patch(`/api/feedback/${f.id}`, { reply: 'Gracias, ya lo corregimos', status: 'done' }));
    const after = await tester.ok(tester.get('/api/feedback'));
    expect(after.items[0]).toMatchObject({ status: 'done', reply: 'Gracias, ya lo corregimos' });
    expect((await tester.ok(tester.get('/api/notifications'))).some((n: any) => n.kind === 'feedback_reply')).toBe(true);
  });

  it('valida el contenido', async () => {
    const u = await newUser();
    expect((await u.post('/api/feedback', { kind: 'idea', message: 'x' })).status).toBe(400);
    expect((await u.post('/api/feedback', { kind: 'spam', message: 'hola hola' })).status).toBe(400);
  });
});
