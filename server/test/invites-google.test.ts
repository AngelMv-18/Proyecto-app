import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, closeApp, getApp, newUser } from './helpers.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';

afterAll(closeApp);

async function adminClient() {
  const first = (await pool.query('SELECT email FROM users ORDER BY created_at, id LIMIT 1')).rows[0];
  if (!first) return newUser();
  const c = new Client(await getApp());
  await c.ok(c.post('/api/auth/login', { email: first.email, password: 'clave-segura-123' }));
  return c;
}
const tokenOf = (url: string) => url.split('/#/invitacion/')[1];

describe('invitaciones para compartir la app', () => {
  beforeAll(() => { (config as any).allowRegistration = false; });
  afterAll(() => { (config as any).allowRegistration = true; });

  it('con el registro cerrado, solo se entra con una invitación válida y se respetan sus usos', async () => {
    const admin = await adminClient();
    const app = await getApp();
    const reg = (invite?: string) => app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-requested-with': 'nova' }, payload: { email: `inv${Date.now()}${Math.random()}@test.local`, password: 'clave-segura-123', display_name: 'Amigo', invite } });
    expect((await reg()).json().error.code).toBe('registration_closed');
    const inv = await admin.ok(admin.post('/api/invites', { max_uses: 2, days: 3, note: 'Familia' }));
    expect(inv.url).toMatch(/\/#\/invitacion\/[A-Za-z0-9_-]{20,}$/);
    const t = tokenOf(inv.url);
    const st = (await app.inject({ method: 'GET', url: `/api/auth/status?invite=${t}` })).json();
    expect(st).toMatchObject({ registration_open: true, invite: { valid: true } });
    expect((await reg(t)).statusCode).toBe(200);
    expect((await reg(t)).statusCode).toBe(200);
    expect((await reg(t)).json().error.code).toBe('invalid_invite'); // agotada
    expect((await reg('falso-123456789012345')).json().error.code).toBe('invalid_invite');
    const list = await admin.ok(admin.get('/api/invites'));
    const mine = list.invites.find((i: any) => i.id === inv.id);
    expect(mine).toMatchObject({ uses: 2, active: false });
    expect(mine.joined).toHaveLength(2);
    // Revocar y vencer
    const inv2 = await admin.ok(admin.post('/api/invites', { max_uses: 5 }));
    await admin.ok(admin.del(`/api/invites/${inv2.id}`));
    expect((await reg(tokenOf(inv2.url))).json().error.code).toBe('invalid_invite');
    const inv3 = await admin.ok(admin.post('/api/invites', {}));
    await pool.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id=$1`, [inv3.id]);
    expect((await reg(tokenOf(inv3.url))).json().error.code).toBe('invalid_invite');
  });

  it('solo el administrador crea invitaciones; cada invitado ve únicamente sus datos', async () => {
    (config as any).allowRegistration = true;
    const friend = await newUser();
    (config as any).allowRegistration = false;
    expect((await friend.post('/api/invites', {})).status).toBe(403);
    expect((await friend.get('/api/invites')).status).toBe(403);
    expect((await friend.ok(friend.get('/api/accounts'))).length).toBe(0);
  });
});

describe('iniciar sesión con Google', () => {
  const idToken = (claims: object) => ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  let next: any = {};
  const fakeGoogle: typeof fetch = (async (url: any) => {
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    return new Response(JSON.stringify({ id_token: idToken(next), access_token: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    (config.google as any).clientId = 'cliente-test.apps.googleusercontent.com'; (config.google as any).clientSecret = 'secreto';
    app = await buildApp({ fetch: fakeGoogle });
  });
  afterAll(async () => { (config.google as any).clientId = ''; (config.google as any).clientSecret = ''; (config as any).allowRegistration = true; await app.close(); });

  async function flow(claims: (nonce: string) => object, invite?: string) {
    const start = await app.inject({ method: 'GET', url: `/api/auth/google/start${invite ? `?invite=${invite}` : ''}` });
    expect(start.statusCode).toBe(302);
    const g = new URL(start.headers.location as string);
    expect(g.hostname).toBe('accounts.google.com');
    expect(g.searchParams.get('scope')).toBe('openid email profile'); // sin permisos de Gmail al iniciar sesión
    next = claims(g.searchParams.get('nonce')!);
    const cb = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${g.searchParams.get('state')}` });
    return { location: cb.headers.location as string, cookie: String(cb.headers['set-cookie'] ?? '') };
  }
  const base = (nonce: string, over: object = {}) => ({ iss: 'https://accounts.google.com', aud: 'cliente-test.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: `g-${Math.random()}`, email: `g${Date.now()}${Math.random()}@gmail.com`, email_verified: true, name: 'Ana López', ...over });

  it('el estado de acceso anuncia Google solo cuando está configurado', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json().google_login).toBe(true);
  });

  it('sin invitación no crea cuentas; con invitación crea la cuenta y abre sesión', async () => {
    (config as any).allowRegistration = false;
    const r1 = await flow((n) => base(n));
    expect(r1.location).toBe('/#/acceso?error=registration_closed');
    const admin = await adminClient();
    const inv = await admin.ok(admin.post('/api/invites', { max_uses: 1 }));
    const email = `nuevo${Date.now()}@gmail.com`;
    const r2 = await flow((n) => base(n, { email, sub: 'sub-nuevo-' + Date.now() }), tokenOf(inv.url));
    expect(r2.location).toBe('/#/');
    expect(r2.cookie).toMatch(/nova_session=/);
    const u = (await pool.query('SELECT has_password, google_sub, invite_id FROM users WHERE email=$1', [email])).rows[0];
    expect(u).toMatchObject({ has_password: false, invite_id: inv.id });
  });

  it('vincula una cuenta existente con el mismo correo verificado y la reconoce después por su sub', async () => {
    (config as any).allowRegistration = true;
    const u = await newUser();
    const sub = 'sub-vinculo-' + Date.now();
    const r = await flow((n) => base(n, { email: u.email, sub }));
    expect(r.location).toBe('/#/');
    expect((await pool.query('SELECT google_sub FROM users WHERE email=$1', [u.email])).rows[0].google_sub).toBe(sub);
    const again = await flow((n) => base(n, { email: 'otro-correo@gmail.com', sub }));
    expect(again.location).toBe('/#/'); // mismo sub, aunque cambie el correo de Google
  });

  it('rechaza nonce alterado, audiencia ajena, correo sin verificar y state reutilizado', async () => {
    expect((await flow(() => base('otro-nonce'))).location).toBe('/#/acceso?error=oauth_invalid');
    expect((await flow((n) => base(n, { aud: 'otra-app' }))).location).toBe('/#/acceso?error=oauth_invalid');
    expect((await flow((n) => base(n, { email_verified: false }))).location).toBe('/#/acceso?error=email_unverified');
    const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    next = base(new URL(start.headers.location as string).searchParams.get('nonce')!);
    await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=a&state=${state}` });
    const reuse = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=a&state=${state}` });
    expect(reuse.headers.location).toBe('/#/acceso?error=estado_vencido');
  });

  it('con 2FA activa, Google no abre sesión directamente: exige el código', async () => {
    (config as any).allowRegistration = true;
    const u = await newUser();
    const sub = 'sub-2fa-' + Date.now();
    await pool.query('UPDATE users SET totp_enabled=true, totp_secret=$2, google_sub=$3 WHERE email=$1', [u.email, 'plain:JBSWY3DPEHPK3PXP', sub]);
    const r = await flow((n) => base(n, { email: u.email, sub }));
    expect(r.location).toMatch(/^\/#\/acceso\?ticket=/);
    expect(r.cookie).not.toMatch(/nova_session=/);
  });

  it('una cuenta creada con Google puede crear su contraseña sin una anterior', async () => {
    const admin = await adminClient();
    const inv = await admin.ok(admin.post('/api/invites', { max_uses: 1 }));
    (config as any).allowRegistration = false;
    const email = `pw${Date.now()}@gmail.com`;
    const r = await flow((n) => base(n, { email, sub: 'sub-pw-' + Date.now() }), tokenOf(inv.url));
    const c = new Client(app); c.cookie = r.cookie.split(';')[0];
    expect((await c.ok(c.get('/api/me'))).has_password).toBe(false);
    await c.ok(c.post('/api/me/password', { next: 'nueva-clave-segura-1' }));
    expect((await c.ok(c.get('/api/me'))).has_password).toBe(true);
    expect((await c.post('/api/me/password', { next: 'otra-clave-segura-2' })).status).toBe(403); // ya exige la actual
  });
});
