import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, getApp, newUser, seededUser, Client } from './helpers.js';
import { resetThrottle, encryptSecret, decryptSecret } from '../src/security.js';
import { pool } from '../src/db.js';

afterAll(closeApp);

describe('autorización y aislamiento', () => {
  it('10. un usuario no puede ver ni modificar los datos de otro', async () => {
    const a = await seededUser();
    const b = await seededUser();
    const tx = (await a.ok(a.post('/api/transactions', { type: 'expense', amount: L(50), account_id: a.cash.id, merchant: 'Secreto' }))).tx;
    const goal = await a.ok(a.post('/api/goals', { name: 'Mi meta', target_amount: L(100) }));
    const debt = await a.ok(a.post('/api/debts', { direction: 'owe', counterparty: 'X', original_amount: L(100) }));
    // B intenta leer / editar / anular
    expect((await b.get(`/api/transactions/${tx.id}`)).status).toBe(404);
    expect((await b.patch(`/api/transactions/${tx.id}`, { amount: 1 })).status).toBe(404);
    expect((await b.post(`/api/transactions/${tx.id}/void`, { reason: 'intento ajeno' })).status).toBe(404);
    expect((await b.get(`/api/transactions/${tx.id}/receipt`)).status).toBe(404);
    expect((await b.patch(`/api/goals/${goal.id}`, { name: 'x' })).status).toBe(404);
    expect((await b.post(`/api/debts/${debt.id}/payments`, { account_id: b.cash.id, amount: 100 })).status).toBe(404);
    expect((await b.patch(`/api/accounts/${a.cash.id}`, { name: 'hack' })).status).toBe(404);
    // B intenta usar cuentas de A
    expect((await b.post('/api/transactions', { type: 'expense', amount: 100, account_id: a.cash.id })).status).toBe(400);
    expect((await b.post('/api/transactions', { type: 'transfer', amount: 100, account_id: b.cash.id, to_account_id: a.bank.id })).status).toBe(400);
    // Listados y búsqueda aislados
    expect((await b.ok(b.get('/api/transactions'))).total).toBe(0);
    expect((await b.ok(b.get('/api/search?q=Secreto'))).transactions).toHaveLength(0);
    expect((await b.ok(b.get('/api/goals'))).find((g: any) => g.name === 'Mi meta')).toBeUndefined();
    expect((await b.get('/api/data/export')).text.includes('Secreto')).toBe(false);
    // Los datos de A siguen intactos
    expect((await a.ok(a.get(`/api/transactions/${tx.id}`))).amount).toBe(L(50));
  });

  it('exige sesión en toda la API privada', async () => {
    const app = await getApp();
    for (const url of ['/api/accounts', '/api/transactions', '/api/dashboard', '/api/me', '/api/data/export', '/api/reports/income_statement']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('protege contra CSRF: las mutaciones sin cabecera o con origen ajeno se rechazan', async () => {
    const u = await newUser();
    const app = await getApp();
    const noHeader = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie: u.cookie }, payload: { name: 'x', type: 'cash' } });
    expect(noHeader.statusCode).toBe(403);
    const evil = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie: u.cookie, 'x-requested-with': 'nova', origin: 'https://evil.example', host: 'localhost:3000' }, payload: { name: 'x', type: 'cash' } });
    expect(evil.statusCode).toBe(403);
  });

  it('la cookie de sesión es HttpOnly y SameSite, y el token no se guarda en claro', async () => {
    await resetThrottle(pool);
    const app = await getApp();
    const u = await newUser();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'nova' }, payload: { email: u.email, password: u.password } });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Lax/i);
    const token = sc.match(/nova_session=([^;]+)/)![1];
    const rows = (await pool.query('SELECT token_hash FROM sessions')).rows.map((x) => x.token_hash);
    expect(rows).not.toContain(token);
    const pw = (await pool.query('SELECT password_hash FROM users WHERE email=$1', [u.email])).rows[0].password_hash;
    expect(pw.startsWith('scrypt$')).toBe(true);
    expect(pw).not.toContain('clave-segura');
  });

  it('bloquea tras demasiados intentos fallidos y no revela si el correo existe', async () => {
    await resetThrottle(pool);
    const app = await getApp();
    const u = await newUser();
    const attempt = (email: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'nova' }, payload: { email, password: 'incorrecta-123' } });
    const known = await attempt(u.email), unknown = await attempt('nadie@test.local');
    expect(known.json().error.message).toBe(unknown.json().error.message);
    let last = known;
    for (let i = 0; i < 9; i++) last = await attempt(u.email);
    expect(last.statusCode).toBe(429);
    await resetThrottle(pool);
  });

  it('el registro se cierra cuando ALLOW_REGISTRATION no está activo y ya hay usuarios', async () => {
    const { config } = await import('../src/config.js');
    config.allowRegistration = false;
    const app = await getApp();
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-requested-with': 'nova' }, payload: { email: 'otro@test.local', password: 'clave-segura-123', display_name: 'X' } });
    config.allowRegistration = true;
    expect(r.statusCode).toBe(403);
  });

  it('cifra y descifra secretos con AES-256-GCM (detecta manipulación)', async () => {
    const { config } = await import('../src/config.js');
    const { createHash } = await import('node:crypto');
    (config as any).encryptionKey = createHash('sha256').update('clave-de-prueba').digest();
    const blob = encryptSecret('refresh-token-secreto');
    expect(blob).not.toContain('refresh');
    expect(decryptSecret(blob)).toBe('refresh-token-secreto');
    const parts = blob.split('.'); parts[2] = Buffer.from('xxxxxxxxxxxxxxxxxxxxx').toString('base64');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
    (config as any).encryptionKey = null;
  });
});

describe('datos: exportación, restauración y borrado', () => {
  it('restaura un respaldo completo con los mismos saldos e historial', async () => {
    const u = await seededUser();
    const e = (await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(300), account_id: u.cash.id, category_id: u.cat('Hogar') }))).tx;
    await u.ok(u.post('/api/transactions', { type: 'refund', amount: L(50), account_id: u.cash.id, refund_of: e.id }));
    const g = await u.ok(u.post('/api/goals', { name: 'Meta', target_amount: L(1000) }));
    await u.ok(u.post(`/api/goals/${g.id}/contribute`, { account_id: u.bank.id, amount: L(200) }));
    await u.ok(u.post('/api/debts', { direction: 'owed', counterparty: 'Ana', original_amount: L(400), cash_account_id: u.bank.id }));
    const before = (await u.ok(u.get('/api/accounts'))).map((a: any) => [a.name, a.balance]);
    const backup = JSON.parse((await u.get('/api/data/export')).text);
    expect(JSON.stringify(backup)).not.toContain('password_hash');
    // Mutamos y restauramos
    await u.ok(u.post('/api/transactions', { type: 'expense', amount: L(999), account_id: u.bank.id }));
    const bad = await u.post('/api/data/restore', { password: 'mala', confirm: 'RESTAURAR', data: backup });
    expect(bad.status).toBe(403);
    await u.ok(u.post('/api/data/restore', { password: u.password, confirm: 'RESTAURAR', data: backup }));
    const after = (await u.ok(u.get('/api/accounts'))).map((a: any) => [a.name, a.balance]);
    expect(after).toEqual(before);
    expect((await u.ok(u.get('/api/transactions'))).total).toBe(backup.transactions.length);
  });

  it('borra todos los datos solo con contraseña y confirmación', async () => {
    const u = await seededUser();
    expect((await u.post('/api/data/wipe', { password: 'x', confirm: 'ELIMINAR' })).status).toBe(403);
    expect((await u.post('/api/data/wipe', { password: u.password, confirm: 'no' })).status).toBe(400);
    await u.ok(u.post('/api/data/wipe', { password: u.password, confirm: 'ELIMINAR' }));
    expect((await u.ok(u.get('/api/accounts'))).length).toBe(0);
  });
});
