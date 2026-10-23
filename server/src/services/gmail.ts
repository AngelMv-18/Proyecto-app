import { config, googleConfigured, googleMissing } from '../config.js';
import { Db, one, rows } from '../db.js';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret } from '../security.js';
import { AppError, badRequest } from '../errors.js';
import { htmlToText, parseFinancialMessage } from './parser.js';
import { ingestParsed } from './ingest.js';
import { newOAuthState, takeOAuthState } from './google.js';

// Solo lectura. No se solicitan permisos de envío ni de modificación.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const DEFAULT_QUERY = 'newer_than:30d (compra OR pago OR consumo OR transferencia OR deposito OR retiro OR débito)';

export type GmailConfig = { senders: string[]; label?: string; default_account_id?: string | null; query?: string };

export function gmailStatus(integration?: any) {
  if (!googleConfigured()) {
    return {
      configured: false, connected: false, missing: googleMissing(),
      steps: [
        'Crea un proyecto en Google Cloud Console y habilita la Gmail API.',
        'Configura la pantalla de consentimiento OAuth y añade el alcance de solo lectura gmail.readonly (es un alcance restringido).',
        `Crea credenciales OAuth tipo "Aplicación web" con URI de redirección: ${config.publicUrl}/api/integrations/gmail/callback`,
        'Define GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y APP_ENCRYPTION_KEY (cadena larga aleatoria) en el entorno del servidor y reinicia.',
        'Para uso personal puedes dejar la app en modo "Pruebas" con tu cuenta como usuario de prueba, pero Google caduca los tokens a los 7 días; en producción sin verificar aparece una advertencia, y un uso público requiere verificación de Google y evaluación de seguridad.',
      ],
    };
  }
  return { configured: true, connected: integration?.status === 'connected', status: integration?.status ?? 'disconnected', account_email: integration?.account_email ?? null, last_sync_at: integration?.last_sync_at ?? null, last_error: integration?.last_error ?? null, config: integration?.config ?? {} };
}

export async function authUrl(db: Db, userId: string) {
  if (!googleConfigured()) throw new AppError(412, 'not_configured', `Gmail no está configurado. Faltan: ${googleMissing().join(', ')}`);
  const state = await newOAuthState(db, { kind: 'gmail', userId });
  // Si la cuenta se creó con Google, se preselecciona ese mismo correo: conectar Gmail es un solo clic.
  const u = await one(db, 'SELECT email, google_sub FROM users WHERE id=$1', [userId]);
  const p = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: `${config.publicUrl}/api/integrations/gmail/callback`, response_type: 'code',
    scope: `${GMAIL_SCOPE} openid email`, access_type: 'offline', prompt: 'consent', state, include_granted_scopes: 'true',
    ...(u?.google_sub ? { login_hint: u.email } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function handleCallback(db: Db, code: string, state: string, f: typeof fetch = fetch) {
  const st = await takeOAuthState<{ kind: string; userId: string }>(db, state);
  if (!st || st.kind !== 'gmail') throw badRequest('Estado OAuth inválido o vencido', 'bad_state');
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.publicUrl}/api/integrations/gmail/callback`, grant_type: 'authorization_code' }),
  });
  const tok: any = await res.json();
  if (!res.ok || !tok.refresh_token) throw new AppError(502, 'oauth_failed', 'Google no devolvió un token de actualización. Revoca el acceso en tu cuenta de Google y vuelve a conectar.');
  if (!String(tok.scope ?? '').includes(GMAIL_SCOPE)) throw badRequest('No se concedió el permiso de lectura de Gmail', 'scope_missing');
  let email: string | null = null;
  try { email = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()).email ?? null; } catch { /* sin email */ }
  await db.query(
    `INSERT INTO integrations(user_id,provider,status,account_email,refresh_token_enc) VALUES ($1,'gmail','connected',$2,$3)
     ON CONFLICT (user_id,provider) DO UPDATE SET status='connected', account_email=$2, refresh_token_enc=$3, last_error=NULL`,
    [st.userId, email, encryptSecret(tok.refresh_token)],
  );
  // Sin pasos extra: si aún no hay cuenta destino, se elige una automáticamente (se puede cambiar después).
  const acc = await pickDefaultAccount(db, st.userId);
  if (acc) await db.query(`UPDATE integrations SET config = jsonb_set(COALESCE(config,'{}'::jsonb), '{default_account_id}', to_jsonb($2::text)) WHERE user_id=$1 AND provider='gmail' AND NOT (COALESCE(config,'{}'::jsonb) ? 'default_account_id')`, [st.userId, acc]);
  await audit(db, st.userId, 'integration', 'gmail', 'connect', null, { account_email: email });
  return st.userId;
}

/** Cuenta donde registrar lo detectado: primero tarjetas/cuentas bancarias, luego cualquier cuenta activa en la moneda principal. */
export async function pickDefaultAccount(db: Db, userId: string): Promise<string | null> {
  const r = await one<{ id: string }>(db, `SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND NOT a.archived
     ORDER BY (a.currency = u.currency) DESC, CASE a.type WHEN 'debit_card' THEN 0 WHEN 'bank' THEN 1 WHEN 'credit_card' THEN 2 WHEN 'wallet' THEN 3 ELSE 4 END, a.sort_order, a.created_at LIMIT 1`, [userId]);
  return r?.id ?? null;
}

export async function disconnect(db: Db, userId: string, f: typeof fetch = fetch) {
  const i = await one(db, `SELECT * FROM integrations WHERE user_id=$1 AND provider='gmail'`, [userId]);
  if (!i) return;
  if (i.refresh_token_enc && config.encryptionKey) {
    try { await f('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: decryptSecret(i.refresh_token_enc) }) }); } catch { /* aunque falle la revocación remota, se borra el token local */ }
  }
  await db.query(`DELETE FROM integrations WHERE user_id=$1 AND provider='gmail'`, [userId]);
  await audit(db, userId, 'integration', 'gmail', 'disconnect');
}

function bodyOf(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; if (p.body?.data && /^text\/(plain|html)/.test(p.mimeType ?? '')) parts.push(p); (p.parts ?? []).forEach(walk); };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain') ?? parts[0];
  if (!plain) return '';
  const txt = Buffer.from(plain.body.data, 'base64url').toString('utf8');
  return plain.mimeType === 'text/html' ? htmlToText(txt) : txt;
}

/**
 * Sincroniza correos: solo lectura, filtrados por remitente/consulta. Del correo solo se conservan los campos
 * extraídos (importe, comercio, referencia, fecha) y el asunto truncado como etiqueta de origen; no se guarda el cuerpo.
 */
export async function syncGmail(db: Db, userId: string, f: typeof fetch = fetch) {
  const i = await one(db, `SELECT * FROM integrations WHERE user_id=$1 AND provider='gmail'`, [userId]);
  if (!googleConfigured()) throw new AppError(412, 'not_configured', `Gmail no está configurado. Faltan: ${googleMissing().join(', ')}`);
  if (!i || i.status !== 'connected') throw new AppError(409, 'not_connected', 'Gmail no está conectado');
  const cfg: GmailConfig = { senders: [], ...(i.config ?? {}) };
  if (!cfg.default_account_id || !(await one(db, 'SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2 AND NOT archived', [cfg.default_account_id, userId]))) {
    cfg.default_account_id = await pickDefaultAccount(db, userId);
    if (!cfg.default_account_id) throw badRequest('Primero crea una cuenta o tarjeta: ahí se registrarán las compras detectadas', 'no_default_account');
    await db.query(`UPDATE integrations SET config=$2 WHERE id=$1`, [i.id, JSON.stringify(cfg)]);
  }

  const tr = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: decryptSecret(i.refresh_token_enc), grant_type: 'refresh_token' }),
  });
  const tj: any = await tr.json();
  if (!tr.ok) {
    await db.query(`UPDATE integrations SET status='error', last_error=$2 WHERE id=$1`, [i.id, 'No se pudo renovar el acceso; vuelve a conectar la cuenta.']);
    throw new AppError(502, 'token_refresh_failed', 'Google rechazó el acceso guardado. Vuelve a conectar Gmail.');
  }
  const h = { authorization: `Bearer ${tj.access_token}` };
  const q = [cfg.query ?? DEFAULT_QUERY, cfg.senders.length ? `(${cfg.senders.map((s) => `from:${s}`).join(' OR ')})` : '', cfg.label ? `label:${cfg.label}` : ''].filter(Boolean).join(' ');
  const list: any = await (await f(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`, { headers: h })).json();
  const stats = { scanned: 0, created: 0, duplicates: 0, ignored: 0, ignored_reasons: [] as string[] };
  for (const m of list.messages ?? []) {
    const msg: any = await (await f(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: h })).json();
    stats.scanned++;
    const hd = (n: string) => msg.payload?.headers?.find((x: any) => x.name.toLowerCase() === n)?.value ?? '';
    const parsed = parseFinancialMessage({ subject: hd('subject'), body: bodyOf(msg.payload), from: hd('from'), receivedAt: new Date(Number(msg.internalDate)).toISOString(), id: m.id });
    if (parsed.kind === 'ignored') { stats.ignored++; if (parsed.reason && stats.ignored_reasons.length < 5) stats.ignored_reasons.push(parsed.reason); continue; }
    const r = await ingestParsed(db, userId, parsed, { account_id: cfg.default_account_id, source: 'email', label: `Correo: ${hd('subject').slice(0, 80)}` });
    if (r.outcome === 'created') stats.created++;
    else if (r.outcome === 'duplicate') stats.duplicates++;
    else { stats.ignored++; if (r.reason && stats.ignored_reasons.length < 5) stats.ignored_reasons.push(r.reason); }
  }
  await db.query(`UPDATE integrations SET last_sync_at=now(), last_error=NULL WHERE id=$1`, [i.id]);
  await audit(db, userId, 'integration', 'gmail', 'sync', null, stats);
  return stats;
}
