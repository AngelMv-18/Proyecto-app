import { afterAll, describe, expect, it } from 'vitest';
import { L, closeApp, getApp, newUser, seededUser } from './helpers.js';
import { totpAt, currentStep, verifyTotp, base32Decode, base32Encode } from '../src/services/totp.js';
import { pool } from '../src/db.js';
import { resetThrottle } from '../src/security.js';

afterAll(closeApp);

describe('TOTP (RFC 6238)', () => {
  it('coincide con los vectores de prueba oficiales (SHA1)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238, apéndice B: T=59 -> 94287082 (8 dígitos); los 6 últimos son 287082
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('no acepta reutilizar un código ya usado', () => {
    const s = base32Encode(Buffer.from('abcdefghijabcdefghij'));
    const code = totpAt(s, currentStep());
    const step = verifyTotp(s, code, null)!;
    expect(step).not.toBeNull();
    expect(verifyTotp(s, code, step)).toBeNull();
    expect(verifyTotp(s, '12345', null)).toBeNull();
  });
});

describe('verificación en dos pasos', () => {
  it('activar, iniciar sesión con código y con código de recuperación, y desactivar', async () => {
    const u = await newUser();
    const app = await getApp();
    expect((await u.post('/api/me/2fa/setup', { password: 'mala' })).status).toBe(403);
    const setup = await u.ok(u.post('/api/me/2fa/setup', { password: u.password }));
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.qr_svg).toContain('<svg');
    expect((await u.post('/api/me/2fa/enable', { code: '000000' })).status).toBe(400);
    const en = await u.ok(u.post('/api/me/2fa/enable', { code: totpAt(setup.secret, currentStep()) }));
    expect(en.recovery_codes).toHaveLength(8);
    const stored = (await pool.query('SELECT totp_secret FROM users WHERE email=$1', [u.email])).rows[0].totp_secret;
    expect(stored).not.toContain(setup.secret.slice(0, 0) + 'enc:'); // sin clave de cifrado en pruebas: queda marcado como plain
    expect(stored.startsWith('plain:')).toBe(true);

    const login = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'nova' }, payload: { email: u.email, password: u.password } });
    const l1 = await login();
    expect(l1.json().two_factor_required).toBe(true);
    expect(l1.headers['set-cookie']).toBeUndefined(); // sin sesión hasta el segundo paso
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login/2fa', headers: { 'x-requested-with': 'nova' }, payload: { ticket: l1.json().ticket, code: '111111' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/login/2fa', headers: { 'x-requested-with': 'nova' }, payload: { ticket: l1.json().ticket, code: totpAt(setup.secret, currentStep() + 1) } });
    expect(good.statusCode).toBe(200);
    expect(String(good.headers['set-cookie'])).toMatch(/nova_session=/);
    // El ticket es de un solo uso
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', headers: { 'x-requested-with': 'nova' }, payload: { ticket: l1.json().ticket, code: totpAt(setup.secret, currentStep()) } })).statusCode).toBe(401);
    // Código de recuperación (una sola vez)
    const l2 = (await login()).json();
    const rec = await app.inject({ method: 'POST', url: '/api/auth/login/2fa', headers: { 'x-requested-with': 'nova' }, payload: { ticket: l2.ticket, code: en.recovery_codes[0].toLowerCase() } });
    expect(rec.statusCode).toBe(200);
    const l3 = (await login()).json();
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', headers: { 'x-requested-with': 'nova' }, payload: { ticket: l3.ticket, code: en.recovery_codes[0] } })).statusCode).toBe(401);
    expect((await u.ok(u.get('/api/me/2fa'))).recovery_remaining).toBe(7);
    // Desactivar exige contraseña y código
    expect((await u.post('/api/me/2fa/disable', { password: u.password, code: '000000' })).status).toBe(400);
    // Simulamos que pasó el tiempo desde el último código usado.
    await pool.query('UPDATE users SET totp_last_step=$2 WHERE email=$1', [u.email, currentStep() - 1]);
    await u.ok(u.post('/api/me/2fa/disable', { password: u.password, code: totpAt(setup.secret, currentStep()) }));
    expect((await login()).json().two_factor_required).toBeUndefined();
  });

  it('el limitador de intentos es persistente (en base de datos)', async () => {
    await resetThrottle(pool);
    const u = await newUser();
    const app = await getApp();
    for (let i = 0; i < 8; i++) await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'nova' }, payload: { email: u.email, password: 'incorrecta-xx' } });
    const rows = (await pool.query(`SELECT hits FROM rate_limits WHERE key LIKE $1`, [`%${u.email}`])).rows;
    expect(rows[0].hits).toBe(8);
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'nova' }, payload: { email: u.email, password: u.password } });
    expect(blocked.statusCode).toBe(429); // incluso con la contraseña correcta
    await resetThrottle(pool);
  });
});

describe('multimoneda con tipo de cambio manual', () => {
  it('sin tipo de cambio la cuenta en USD se excluye; con tipo de cambio se suma como estimación', async () => {
    const u = await seededUser();
    const usd = await u.ok(u.post('/api/accounts', { name: 'Ahorro USD', type: 'savings', currency: 'USD', opening_balance: L(100), opening_date: '2020-01-01' }));
    let d = await u.ok(u.get('/api/dashboard'));
    expect(d.available).toBe(L(11000));
    expect(d.foreign_accounts).toBe(1);
    await u.ok(u.put('/api/fx', { currency: 'USD', rate: 24.75 }));
    d = await u.ok(u.get('/api/dashboard'));
    expect(d.available).toBe(L(11000) + L(2475));
    expect(d.foreign_accounts).toBe(0);
    expect(d.converted_accounts).toBe(1);
    expect(d.month.income).toBe(0); // la conversión no crea ingresos
    const nw = await u.ok(u.get('/api/reports/net_worth'));
    expect(nw.totals['Patrimonio neto estimado']).toBe(L(11000) + L(2475));
    expect(nw.quality.notes.join(' ')).toMatch(/tipo de cambio manual/);
    // Transferencia entre monedas requiere el importe recibido
    const bad = await u.post('/api/transactions', { type: 'transfer', amount: L(250), account_id: u.bank.id, to_account_id: usd.id });
    expect(bad.body.error.code).toBe('fx_amount_required');
    await u.ok(u.post('/api/transactions', { type: 'transfer', amount: L(250), to_amount: L(10), account_id: u.bank.id, to_account_id: usd.id }));
    const accs = await u.ok(u.get('/api/accounts'));
    expect(accs.find((a: any) => a.name === 'Ahorro USD').balance).toBe(L(110));
    expect((await u.put('/api/fx', { currency: 'HNL', rate: 1 })).status).toBe(400);
  });
});
