import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { resetThrottle } from '../src/security.js';

export type App = Awaited<ReturnType<typeof buildApp>>;
let appPromise: Promise<App> | null = null;
export const getApp = () => (appPromise ??= buildApp());
export async function closeApp() { if (appPromise) await (await appPromise).close(); appPromise = null; await pool.end(); }

let n = 0;
export class Client {
  cookie = '';
  constructor(public app: App) {}
  async call(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any, url, payload: body === undefined ? undefined : body,
      headers: { 'x-requested-with': 'nova', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const sc = res.headers['set-cookie'];
    if (sc) { const c = (Array.isArray(sc) ? sc[0] : sc).split(';')[0]; this.cookie = c.endsWith('=') ? '' : c; }
    let json: any; try { json = res.json(); } catch { json = undefined; }
    return { status: res.statusCode, body: json, text: res.body, headers: res.headers };
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b: any = {}) => this.call('POST', u, b);
  patch = (u: string, b: any) => this.call('PATCH', u, b);
  put = (u: string, b: any) => this.call('PUT', u, b);
  del = (u: string) => this.call('DELETE', u);
  async ok(r: Promise<{ status: number; body: any }>) { const x = await r; if (x.status >= 300) throw new Error(`HTTP ${x.status}: ${JSON.stringify(x.body)}`); return x.body; }
}

export async function newUser(opts: { currency?: string } = {}) {
  resetThrottle();
  const app = await getApp();
  const c = new Client(app);
  const email = `u${Date.now()}_${++n}@test.local`;
  const r = await c.post('/api/auth/register', { email, password: 'clave-segura-123', display_name: 'Tester', currency: opts.currency ?? 'HNL' });
  if (r.status !== 200) throw new Error('register failed ' + JSON.stringify(r.body));
  return Object.assign(c, { email, password: 'clave-segura-123', user: r.body });
}

export const L = (x: number) => Math.round(x * 100); // lempiras -> centavos

/** Usuario con cuentas típicas: efectivo (1,000), banco (10,000), tarjeta (límite 20,000). */
export async function seededUser() {
  const u = await newUser();
  const cash = await u.ok(u.post('/api/accounts', { name: 'Efectivo', type: 'cash', opening_balance: L(1000), opening_date: '2020-01-01' }));
  const bank = await u.ok(u.post('/api/accounts', { name: 'Banco', type: 'bank', opening_balance: L(10000), opening_date: '2020-01-01' }));
  const card = await u.ok(u.post('/api/accounts', { name: 'Tarjeta', type: 'credit_card', opening_balance: 0, credit_limit: L(20000), opening_date: '2020-01-01' }));
  const cats = await u.ok(u.get('/api/categories'));
  const cat = (name: string) => cats.find((c: any) => c.name === name && !c.parent_id)?.id as string;
  return Object.assign(u, { cash, bank, card, cat });
}

export const balances = async (u: Client) => Object.fromEntries((await u.ok(u.get('/api/accounts'))).map((a: any) => [a.name, a.balance])) as Record<string, number>;
