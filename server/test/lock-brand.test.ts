import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { isoCBOR, isoBase64URL } from '@simplewebauthn/server/helpers';
import { closeApp, newUser, getApp, Client } from './helpers.js';
import { pool } from '../src/db.js';

afterAll(closeApp);

/** Autenticador de plataforma simulado (como la huella del teléfono): clave ES256 y verificación de usuario. */
class SoftAuthenticator {
  key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  credId = randomBytes(16);
  counter = 0;
  constructor(public origin = 'http://localhost:3000', public rpID = 'localhost') {}
  private rpHash() { return createHash('sha256').update(this.rpID).digest(); }
  private cd(type: string, challenge: string) { return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })); }
  register(options: any) {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as any;
    const cose = isoCBOR.encode(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, Buffer.from(cose)]);
    const att = isoCBOR.encode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
    const id = isoBase64URL.fromBuffer(new Uint8Array(this.credId));
    return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(this.cd('webauthn.create', options.challenge))), attestationObject: isoBase64URL.fromBuffer(new Uint8Array(att)), transports: ['internal'] } };
  }
  assert(options: any, { uv = true, tamper = false } = {}) {
    this.counter++;
    const c = Buffer.alloc(4); c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([uv ? 0x05 : 0x01]), c]);
    const cdj = this.cd('webauthn.get', options.challenge);
    let sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cdj).digest()]), this.key.privateKey);
    if (tamper) sig = Buffer.from(sig.map((x, i) => (i === sig.length - 1 ? x ^ 1 : x)));
    const id = isoBase64URL.fromBuffer(new Uint8Array(this.credId));
    return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(cdj)), authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authData)), signature: isoBase64URL.fromBuffer(new Uint8Array(sig)), userHandle: undefined } };
  }
}

async function withFingerprint(u: Client) {
  const auth = new SoftAuthenticator();
  const opts = await u.ok(u.post('/api/lock/register/options'));
  expect(opts.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' });
  const r = await u.ok(u.post('/api/lock/register/verify', { response: auth.register(opts), label: 'Pixel de prueba' }));
  expect(r.lock.enabled).toBe(true);
  return auth;
}
const expire = (u: any) => pool.query(`UPDATE sessions SET unlocked_until = now() - interval '1 minute' WHERE user_id=$1`, [u.user.id]);

describe('bloqueo con huella (WebAuthn)', () => {
  it('registra la huella, bloquea los datos en el servidor y desbloquea con una firma válida', async () => {
    const u = await newUser();
    const auth = await withFingerprint(u);
    expect((await u.get('/api/accounts')).status).toBe(200); // recién registrada: desbloqueada
    await expire(u);
    const locked = await u.get('/api/accounts');
    expect(locked.status).toBe(423);
    expect((await u.get('/api/dashboard')).status).toBe(423);
    expect((await u.get('/api/data/export')).status).toBe(423);
    const st = await u.ok(u.get('/api/lock/status'));
    expect(st).toMatchObject({ enabled: true, locked: true });
    expect(st.credentials).toHaveLength(1);
    const opts = await u.ok(u.post('/api/lock/unlock/options'));
    await u.ok(u.post('/api/lock/unlock/verify', { response: auth.assert(opts) }));
    expect((await u.get('/api/accounts')).status).toBe(200);
  });

  it('rechaza firmas manipuladas, sin verificación de usuario o con desafío reutilizado', async () => {
    const u = await newUser();
    const auth = await withFingerprint(u);
    await expire(u);
    let opts = await u.ok(u.post('/api/lock/unlock/options'));
    expect((await u.post('/api/lock/unlock/verify', { response: auth.assert(opts, { tamper: true }) })).status).toBe(401);
    opts = await u.ok(u.post('/api/lock/unlock/options'));
    expect((await u.post('/api/lock/unlock/verify', { response: auth.assert(opts, { uv: false }) })).status).toBe(401);
    opts = await u.ok(u.post('/api/lock/unlock/options'));
    const good = auth.assert(opts);
    await u.ok(u.post('/api/lock/unlock/verify', { response: good }));
    await expire(u);
    expect((await u.post('/api/lock/unlock/verify', { response: good })).status).toBe(400); // desafío de un solo uso
    expect((await u.get('/api/accounts')).status).toBe(423);
  });

  it('otra persona no puede usar su huella para desbloquear mi sesión', async () => {
    const me = await newUser(); await withFingerprint(me);
    const other = await newUser(); const otherAuth = await withFingerprint(other);
    await expire(me);
    const opts = await me.ok(me.post('/api/lock/unlock/options'));
    expect((await me.post('/api/lock/unlock/verify', { response: otherAuth.assert(opts) })).status).toBe(401);
    expect((await me.get('/api/accounts')).status).toBe(423);
  });

  it('se puede desbloquear con la contraseña y desactivar al borrar la última huella', async () => {
    const u = await newUser();
    const auth = await withFingerprint(u); void auth;
    await expire(u);
    expect((await u.post('/api/lock/unlock/password', { password: 'mala' })).status).toBe(401);
    await u.ok(u.post('/api/lock/unlock/password', { password: u.password }));
    expect((await u.get('/api/accounts')).status).toBe(200);
    expect((await u.patch('/api/lock/settings', { timeout_min: 7 })).status).toBe(400);
    await u.ok(u.patch('/api/lock/settings', { timeout_min: 5 }));
    const st = await u.ok(u.get('/api/lock/status'));
    await u.ok(u.del(`/api/lock/credentials/${encodeURIComponent(st.credentials[0].full_id)}`));
    expect((await u.ok(u.get('/api/lock/status'))).enabled).toBe(false);
    await expire(u);
    expect((await u.get('/api/accounts')).status).toBe(200); // sin huellas no hay bloqueo
  });

  it('un inicio de sesión nuevo entra desbloqueado; sin sesión sigue siendo 401', async () => {
    const u = await newUser(); await withFingerprint(u); await expire(u);
    const app = await getApp();
    const c = new Client(app);
    await c.ok(c.post('/api/auth/login', { email: u.email, password: u.password }));
    expect((await c.get('/api/accounts')).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/lock/status' })).statusCode).toBe(401);
  });
});

describe('apariencia de la instalación', () => {
  const png = async (size: number) => {
    // PNG mínimo válido de tamaño size×size (cabecera IHDR correcta; contenido irrelevante para la validación).
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(size, 8); ihdr.writeUInt32BE(size, 12);
    return Buffer.concat([sig, ihdr, randomBytes(200)]).toString('base64');
  };

  it('solo el administrador cambia nombre, colores y logotipo; el manifiesto e ícono los reflejan', async () => {
    const { rows } = await pool.query('SELECT email FROM users ORDER BY created_at, id LIMIT 1');
    // En pruebas, el administrador es el primer usuario existente; si no hay ninguno se crea.
    let admin: Client & any;
    if (!rows.length) admin = await newUser();
    else { const app = await getApp(); admin = new Client(app); await admin.ok(admin.post('/api/auth/login', { email: rows[0].email, password: 'clave-segura-123' })); }
    const other = await newUser();
    expect((await other.put('/api/appearance', { app_name: 'Hack', accent: '#ff0000', background: 'oled' })).status).toBe(403);
    const pub = (await (await getApp()).inject({ method: 'GET', url: '/api/appearance' })).json();
    expect(pub.app_name).toBeTruthy();
    expect(pub.is_admin).toBe(false);
    expect((await admin.ok(admin.get('/api/appearance'))).is_admin).toBe(true);
    expect((await admin.put('/api/appearance', { app_name: 'Mis Finanzas', accent: 'rojo', background: 'oled' })).status).toBe(400);
    await admin.ok(admin.put('/api/appearance', { app_name: 'Mis Finanzas', accent: '#2DE2D0', background: 'midnight' }));
    const app = await getApp();
    const m = (await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json();
    expect(m).toMatchObject({ name: 'Mis Finanzas', short_name: 'Mis', theme_color: '#070B18' });
    expect((await admin.put('/api/appearance/logo', { png192: Buffer.from('<svg/>').toString('base64'), png512: await png(512) })).status).toBe(400);
    expect((await admin.put('/api/appearance/logo', { png192: await png(100), png512: await png(512) })).status).toBe(400);
    await admin.ok(admin.put('/api/appearance/logo', { png192: await png(192), png512: await png(512) }));
    const icon = await app.inject({ method: 'GET', url: '/brand/icon-192.png' });
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.rawPayload.readUInt32BE(16)).toBe(192);
    expect((await (await getApp()).inject({ method: 'GET', url: '/api/appearance' })).json().has_logo).toBe(true);
    await admin.ok(admin.del('/api/appearance'));
    expect((await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json().name).toBe('NOVA FINANCE');
  });
});
