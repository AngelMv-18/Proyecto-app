import { useRef, useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { BiometricLock } from './Appearance';
import { Field, Sheet, Switch, confirmDialog, nav, toast, toastError, useAction, useApi, useIsAdmin } from '../ui';

const LOCALES = [['es-HN', 'Honduras'], ['es-MX', 'México'], ['es-GT', 'Guatemala'], ['es-SV', 'El Salvador'], ['es-ES', 'España'], ['es-CO', 'Colombia'], ['en-US', 'English (US)']];
const CURRENCIES = ['HNL', 'USD', 'EUR', 'MXN', 'GTQ', 'COP', 'CRC', 'NIO'];
const ZONES = ['America/Tegucigalpa', 'America/Mexico_City', 'America/Guatemala', 'America/El_Salvador', 'America/Bogota', 'America/Costa_Rica', 'America/New_York', 'Europe/Madrid'];

function DataSheet({ kind, onClose }: { kind: 'restore' | 'wipe' | 'delete'; onClose: () => void }) {
  const [pw, setPw] = useState(''); const [txt, setTxt] = useState(''); const [data, setData] = useState<any>(null); const [run, busy] = useAction();
  const word = kind === 'restore' ? 'RESTAURAR' : kind === 'wipe' ? 'ELIMINAR' : 'ELIMINAR MI CUENTA';
  const title = kind === 'restore' ? 'Restaurar respaldo' : kind === 'wipe' ? 'Borrar todos mis datos' : 'Eliminar mi cuenta';
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="alert critical" style={{ marginBottom: 14 }}><Icon name="warn" size={20} /><span className="small">{kind === 'restore' ? 'Reemplaza TODOS tus datos financieros actuales por los del archivo.' : kind === 'wipe' ? 'Borra cuentas, movimientos, metas, deudas y presupuestos. No se puede deshacer; descarga un respaldo antes.' : 'Elimina tu usuario y todos sus datos de forma permanente.'}</span></div>
      {kind === 'restore' && <Field id="rf" label="Archivo de respaldo (.json)"><input id="rf" type="file" accept="application/json,.json" className="input" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setData(JSON.parse(await f.text())); } catch { toast('El archivo no es un JSON válido', 'error'); } }} /></Field>}
      <Field id="dpw" label="Tu contraseña"><input id="dpw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
      <Field id="dtx" label={`Escribe ${word} para confirmar`}><input id="dtx" className="input" value={txt} onChange={(e) => setTxt(e.target.value)} /></Field>
      <button className="btn danger block" disabled={busy || txt !== word || !pw || (kind === 'restore' && !data)} onClick={async () => {
        const r = await run(() => api.post(kind === 'restore' ? '/api/data/restore' : kind === 'wipe' ? '/api/data/wipe' : '/api/data/delete-account', { password: pw, confirm: word, ...(kind === 'restore' ? { data } : {}) }), kind === 'restore' ? 'Respaldo restaurado' : 'Hecho');
        if (r) { onClose(); if (kind === 'delete') location.reload(); }
      }}>{title}</button>
    </Sheet>
  );
}

function TwoFactor() {
  const admin = useIsAdmin();
  const { data: st } = useApi<any>('/api/me/2fa');
  const [pw, setPw] = useState(''); const [setup, setSetup] = useState<any>(null); const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  const [run, busy] = useAction();
  if (!st) return null;
  return (
    <div>
      <h3>Verificación en dos pasos</h3>
      {st.enabled ? (<>
        <p className="small"><span className="badge teal">Activa</span> Códigos de recuperación disponibles: <b>{st.recovery_remaining}</b></p>
        {codes && <div className="card flat fade-in"><p className="small" style={{ marginTop: 0 }}><b>Guarda estos códigos en un lugar seguro.</b> Cada uno sirve una sola vez si pierdes tu teléfono. No se volverán a mostrar.</p><div className="grid cols-2" style={{ gap: 6 }}>{codes.map((c) => <code key={c}>{c}</code>)}</div></div>}
        <Field id="d2p" label="Contraseña"><input id="d2p" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
        <Field id="d2c" label="Código actual"><input id="d2c" className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" /></Field>
        <button className="btn danger" disabled={busy || !pw || code.length < 6} onClick={async () => { const r = await run(() => api.post('/api/me/2fa/disable', { password: pw, code }), 'Verificación en dos pasos desactivada'); if (r) { setPw(''); setCode(''); setCodes(null); } }}>Desactivar</button>
      </>) : !setup ? (<>
        <p className="small muted" style={{ marginTop: 0 }}>Protege tu acceso con un código de una app como Google Authenticator, Aegis o Authy.</p>
        <Field id="s2p" label="Confirma tu contraseña"><input id="s2p" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
        <button className="btn" disabled={busy || !pw} onClick={async () => { const r = await run(() => api.post('/api/me/2fa/setup', { password: pw })); if (r) { setSetup(r); setPw(''); } }}><Icon name="lock" size={18} />Configurar</button>
      </>) : (
        <div className="fade-in">
          <p className="small" style={{ marginTop: 0 }}>1. Escanea el código con tu app de autenticación (o copia la clave).</p>
          <div style={{ width: 180, background: '#fff', padding: 8, borderRadius: 12 }} dangerouslySetInnerHTML={{ __html: setup.qr_svg }} aria-label="Código QR para la app de autenticación" role="img" />
          <p className="xs" style={{ overflowWrap: 'anywhere' }}>Clave: <code style={{ userSelect: 'all' }}>{setup.secret}</code></p>
          {!st.secret_encrypted && admin && <p className="hint warn">Este servidor no tiene APP_ENCRYPTION_KEY: el secreto se guarda sin cifrar en la base de datos. Defínela para cifrarlo.</p>}
          <Field id="e2c" label="2. Escribe el código que muestra la app"><input id="e2c" className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" /></Field>
          <button className="btn primary" disabled={busy || code.length < 6} onClick={async () => { const r = await run(() => api.post('/api/me/2fa/enable', { code }), 'Verificación en dos pasos activada'); if (r) { setCodes(r.recovery_codes); setSetup(null); setCode(''); } }}>Activar</button>
        </div>
      )}
    </div>
  );
}

const b64ToBytes = (b64: string) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

function PushCard() {
  const admin = useIsAdmin();
  const { data: st, reload } = useApi<any>('/api/push/status');
  const [run, busy] = useAction();
  const [here, setHere] = useState<boolean | null>(null);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const check = async () => { try { const r = await navigator.serviceWorker.getRegistration(); setHere(Boolean(await r?.pushManager.getSubscription())); } catch { setHere(false); } };
  if (supported && here === null) check();
  if (!st) return null;
  const save = (patch: any) => run(() => api.patch('/api/me', { settings: patch }), 'Preferencias guardadas').then(reload);
  const enable = async () => {
    if (Notification.permission === 'denied') return toast('Las notificaciones están bloqueadas para este sitio en el navegador. Actívalas en los ajustes del sitio.', 'error');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('No se concedió el permiso de notificaciones', 'error');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.public_key) });
    await run(() => api.post('/api/push/subscribe', sub.toJSON()), 'Notificaciones activadas en este dispositivo');
    check(); reload();
  };
  const disable = async () => {
    const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
    if (sub) { await run(() => api.post('/api/push/unsubscribe', { endpoint: sub.endpoint })); await sub.unsubscribe(); }
    check(); reload();
  };
  return (
    <section className="card"><h2>Notificaciones y resúmenes</h2>
      {!st.configured ? (admin
          ? <p className="small muted" style={{ marginTop: 0 }}><span className="badge">No configurado</span> El servidor no tiene claves VAPID ({st.missing.join(', ')}). Genera unas con <code>npx web-push generate-vapid-keys</code>. Mientras tanto, las alertas y resúmenes aparecen dentro de la app.</p>
          : <p className="small muted" style={{ marginTop: 0 }}>Las notificaciones en el teléfono aún no están disponibles. Mientras tanto, verás tus alertas y resúmenes dentro de la app.</p>)
        : !supported ? <p className="small muted">Este navegador no admite notificaciones push. En Android usa Chrome e instala la app (“Agregar a pantalla de inicio”).</p>
        : <div className="row wrap" style={{ marginBottom: 10 }}>
            <span className={`badge ${here ? 'teal' : ''}`}>{here ? 'Activas en este dispositivo' : 'Inactivas en este dispositivo'}</span><span className="xs faint">{st.devices} dispositivo(s)</span>
            {here ? <><button className="btn sm" disabled={busy} onClick={() => run(() => api.post('/api/push/test'), 'Notificación de prueba enviada')}>Probar</button><button className="btn sm ghost" onClick={disable}>Desactivar aquí</button></> : <button className="btn sm primary" disabled={busy} onClick={() => enable().catch(toastError)}>Activar en este dispositivo</button>}
          </div>}
      <Switch label="Modo privado" hint="La pantalla de bloqueo no muestra importes ni comercios" checked={st.push.private} onChange={(v) => save({ push: { private: v } })} />
      <Field id="psev" label="Enviar al teléfono alertas desde"><select id="psev" className="input" value={st.push.min_severity} onChange={(e) => save({ push: { min_severity: e.target.value } })}><option value="info">Informativas</option><option value="warning">Advertencias</option><option value="critical">Solo críticas</option></select></Field>
      <div className="hr" /><h3 style={{ marginBottom: 4 }}>Resúmenes automáticos</h3>
      <Switch label="Diario (20:00)" checked={st.digests.daily} onChange={(v) => save({ digests: { daily: v } })} />
      <Switch label="Semanal (domingo 19:00)" checked={st.digests.weekly} onChange={(v) => save({ digests: { weekly: v } })} />
      <Switch label="Mensual (día 1, 08:00)" checked={st.digests.monthly} onChange={(v) => save({ digests: { monthly: v } })} />
      <p className="hint">Hora de tu zona horaria. También puedes verlos cuando quieras en Informes → Resúmenes.</p>
    </section>
  );
}

function FxRates({ me }: { me: any }) {
  const { data: rates } = useApi<any[]>('/api/fx');
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const foreign = [...new Set((accounts ?? []).filter((a) => a.currency !== me.currency && !a.archived).map((a) => a.currency))];
  const [cur, setCur] = useState(''); const [rate, setRate] = useState(''); const [run, busy] = useAction();
  return (
    <section className="card"><h2>Tipos de cambio</h2>
      <p className="small muted" style={{ marginTop: 0 }}>Para sumar cuentas en otra moneda a tu saldo y patrimonio, indica cuántos {me.currency} vale 1 unidad. Es un valor manual (no se consulta en internet) y los totales se marcan como estimación. Ingresos y gastos siguen contando solo la moneda principal.</p>
      {(rates ?? []).map((r) => <div key={r.currency} className="row between small" style={{ padding: '4px 0' }}><span>1 {r.currency} = <b className="num">{Number(r.rate)}</b> {me.currency}</span><span className="row"><span className="faint xs">{dateTime(r.updated_at)}</span><button className="btn sm ghost" onClick={() => run(() => api.del(`/api/fx/${r.currency}`), 'Tipo de cambio eliminado')}>Quitar</button></span></div>)}
      {foreign.filter((c) => !(rates ?? []).some((r) => r.currency === c)).length > 0 && <p className="hint warn">Sin tipo de cambio (se excluyen de los totales): {foreign.filter((c) => !(rates ?? []).some((r) => r.currency === c)).join(', ')}</p>}
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="fxc" label="Moneda"><input id="fxc" className="input" maxLength={3} value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} placeholder="USD" /></Field>
        <Field id="fxr" label={`Valor en ${me.currency}`}><input id="fxr" className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="24.75" /></Field>
      </div>
      <button className="btn" disabled={busy || cur.length !== 3 || !Number(rate.replace(',', '.'))} onClick={async () => { const r = await run(() => api.put('/api/fx', { currency: cur, rate: Number(rate.replace(',', '.')) }), 'Tipo de cambio guardado'); if (r) { setCur(''); setRate(''); } }}>Guardar tipo de cambio</button>
    </section>
  );
}

export function Profile({ me }: { me: any }) {
  const admin = useIsAdmin();
  const [name, setName] = useState(me.display_name); const [locale, setLocale] = useState(me.locale); const [cur, setCur] = useState(me.currency); const [tz, setTz] = useState(me.timezone);
  const a = me.settings.alerts;
  const [al, setAl] = useState({ ...a, limit: a.large_expense_limit ? String(a.large_expense_limit / 100) : '' });
  const [pw, setPw] = useState({ current: '', next: '' }); const [sheet, setSheet] = useState<null | 'restore' | 'wipe' | 'delete'>(null); const [run, busy] = useAction();
  const { data: sessions } = useApi<any[]>('/api/me/sessions');
  const { data: audit } = useApi<any[]>('/api/audit?limit=15');
  const [showAudit, setShowAudit] = useState(false);
  const saveFmt = async () => { const r = await run(() => api.patch('/api/me', { display_name: name, locale, currency: cur, timezone: tz }), 'Preferencias guardadas'); if (r) setTimeout(() => location.reload(), 600); };
  const saveAlerts = () => { const { limit, ...rest } = al; return run(() => api.patch('/api/me', { settings: { alerts: { ...rest, large_expense_limit: limit ? Math.round(Number(String(limit).replace(',', '.')) * 100) || null : null } } }), 'Alertas actualizadas'); };
  const Link = ({ to, icon, label, sub }: { to: string; icon: string; label: string; sub: string }) => <button className="item" onClick={() => nav(to)}><span className="avatar"><Icon name={icon} /></span><span className="grow"><div className="t">{label}</div><div className="s">{sub}</div></span><Icon name="chevron" size={18} /></button>;
  return (
    <div className="stack">
      <h1>Perfil</h1>
      <section className="card glow"><div className="row"><span className="avatar" style={{ width: 54, height: 54, fontSize: '1.4rem', fontFamily: 'var(--display)', color: 'var(--lime)' }}>{me.display_name.slice(0, 1).toUpperCase()}</span><div className="grow"><h2 style={{ margin: 0 }}>{me.display_name}</h2><div className="small muted">{me.email}</div></div></div></section>
      <section className="card"><h2>Gestión</h2><div className="list">
        <Link to="/cuentas" icon="wallet" label="Cuentas" sub="Efectivo, bancos, tarjetas y conciliación" /><Link to="/metas" icon="target" label="Metas de ahorro" sub="Progreso y planes" /><Link to="/deudas" icon="scale" label="Deudas y préstamos" sub="Lo que debo y me deben" />
        <Link to="/recurrentes" icon="repeat" label="Pagos recurrentes" sub="Suscripciones, facturas y servicios" /><Link to="/informes" icon="chart" label="Informes" sub="Estados, flujo de caja y exportación" /><Link to="/integraciones" icon="plug" label="Integraciones" sub="Vincular tu Gmail" /><Link to="/revision" icon="check" label="Revisión de movimientos" sub="Detectados e importados" />
        {admin ? <Link to="/apariencia" icon="spark" label="Apariencia y bloqueo con huella" sub="Colores, nombre, logotipo y desbloqueo biométrico" />
          : <Link to="/apariencia" icon="spark" label="Bloqueo con huella" sub="Pide tu huella al abrir la app" />}
        {/* Solo el administrador invita personas (el servidor también lo exige). */}
        {admin && <Link to="/compartir" icon="send" label="Compartir app" sub="Invita a amigos y familiares a probarla" />}
        <Link to="/comentarios" icon="edit" label="Comentarios y sugerencias" sub="Cuéntanos qué falla o qué te gustaría" />
      </div></section>
      <div className="grid cols-2">
        <section className="card"><h2>Formato y región</h2>
          <Field id="pn" label="Nombre"><input id="pn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="pl" label="Formato de fechas y números"><select id="pl" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>{LOCALES.map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}</select></Field>
          <Field id="pc" label="Moneda principal" hint="Solo se puede cambiar mientras no tengas movimientos."><select id="pc" className="input" value={cur} onChange={(e) => setCur(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field id="pz" label="Zona horaria"><select id="pz" className="input" value={tz} onChange={(e) => setTz(e.target.value)}>{ZONES.map((z) => <option key={z}>{z}</option>)}</select></Field>
          <button className="btn primary" disabled={busy} onClick={saveFmt}>Guardar</button>
        </section>
        <section className="card"><h2>Alertas</h2>
          <Switch label="Presupuestos (50, 75, 90 y 100 %)" checked={al.budget} onChange={(v) => setAl({ ...al, budget: v })} />
          <Switch label="Saldo insuficiente previsto" checked={al.low_balance} onChange={(v) => setAl({ ...al, low_balance: v })} />
          <Switch label="Suscripciones próximas" checked={al.subscriptions} onChange={(v) => setAl({ ...al, subscriptions: v })} />
          <Switch label="Metas retrasadas" checked={al.goals} onChange={(v) => setAl({ ...al, goals: v })} />
          <Switch label="Movimientos por revisar" checked={al.review} onChange={(v) => setAl({ ...al, review: v })} />
          <Switch label="Posibles duplicados" checked={al.duplicates} onChange={(v) => setAl({ ...al, duplicates: v })} />
          <Switch label="Diferencias de conciliación" checked={al.reconciliation} onChange={(v) => setAl({ ...al, reconciliation: v })} />
          <Switch label="Movimientos inusuales (para revisar)" checked={al.unusual} onChange={(v) => setAl({ ...al, unusual: v })} />
          <Field id="pg" label="Avisarme de gastos mayores a" hint="Vacío = desactivado"><input id="pg" className="input" inputMode="decimal" value={al.limit} onChange={(e) => setAl({ ...al, limit: e.target.value })} /></Field>
          <button className="btn primary" disabled={busy} onClick={saveAlerts}>Guardar alertas</button>
          <p className="hint">Cada hecho avisa una sola vez. Para recibirlas en el teléfono activa las notificaciones más abajo.</p>
        </section>
      </div>
      <PushCard />
      <FxRates me={me} />
      <section className="card"><h2>Mis datos</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Puedes llevarte todo en cualquier momento y restaurarlo después.</p>
        <div className="row wrap">
          <a className="btn" href="/api/data/export"><Icon name="download" size={18} />Descargar respaldo completo (JSON)</a>
          <a className="btn" href="/api/export/transactions.csv"><Icon name="download" size={18} />Movimientos (CSV)</a>
          <button className="btn" onClick={() => setSheet('restore')}><Icon name="upload" size={18} />Restaurar respaldo</button>
        </div>
        <div className="hr" /><div className="row wrap"><button className="btn danger" onClick={() => setSheet('wipe')}>Borrar mis datos</button><button className="btn danger" onClick={() => setSheet('delete')}>Eliminar mi cuenta</button></div>
        <div className="hr" /><button className="btn sm ghost" onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'Ocultar' : 'Ver'} registro de auditoría</button>
        {showAudit && <div className="stack fade-in" style={{ gap: 4, marginTop: 8 }}>{audit?.map((e) => <div key={e.id} className="row between xs"><span>{e.entity} · {e.action}{e.detail ? ` — ${e.detail}` : ''}</span><span className="faint">{dateTime(e.created_at)}</span></div>)}</div>}
      </section>
      <div className="grid cols-2">
        <section className="card"><h2>Seguridad</h2>
          {me.google && <p className="small muted" style={{ marginTop: 0 }}>Tu cuenta está vinculada con Google.{me.has_password ? '' : ' Puedes crear también una contraseña para entrar sin Google o desbloquear la app si falla la huella.'}</p>}
          {me.has_password !== false && <Field id="cp" label="Contraseña actual"><input id="cp" type="password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>}
          <Field id="np" label="Nueva contraseña (mín. 10)"><input id="np" type="password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <button className="btn" disabled={busy || pw.next.length < 10} onClick={async () => { const r = await run(() => api.post('/api/me/password', { ...(me.has_password !== false ? { current: pw.current } : {}), next: pw.next }), me.has_password !== false ? 'Contraseña cambiada; otras sesiones cerradas' : 'Contraseña creada'); if (r) { setPw({ current: '', next: '' }); if (me.has_password === false) location.reload(); } }}>{me.has_password !== false ? 'Cambiar contraseña' : 'Crear contraseña'}</button>
          <div className="hr" /><h3>Bloqueo con huella</h3><BiometricLock />
          <div className="hr" /><TwoFactor />
          <div className="hr" /><h3>Sesiones activas</h3>
          {sessions?.map((s, i) => <div key={i} className="xs muted" style={{ overflowWrap: 'anywhere' }}>{dateTime(s.created_at)} · {s.user_agent?.slice(0, 60) || 'dispositivo'}</div>)}
          <div className="hr" /><button className="btn" onClick={async () => { await api.post('/api/auth/logout').catch(toastError); location.reload(); }}><Icon name="logout" size={18} />Cerrar sesión</button>
        </section>
        <section className="card"><h2>Qué protege realmente esta app</h2>
          <ul className="small muted" style={{ paddingLeft: 18, display: 'grid', gap: 5, margin: 0 }}>
            <li>Contraseña con scrypt; sesión en cookie HttpOnly (el token se guarda con hash).</li><li>Cada consulta se filtra por tu usuario en el servidor; hay pruebas automáticas de aislamiento.</li>
            <li>Validación de entradas, protección CSRF, límite de intentos de acceso y cabeceras de seguridad (CSP).</li><li>Los saldos se calculan desde los movimientos; nada se borra en silencio y todo cambio queda auditado.</li>
            <li>Tokens de Google cifrados en reposo (AES-256-GCM) y solo en el servidor. No guardamos claves bancarias.</li><li>Los registros técnicos no incluyen importes, comercios ni cuerpos de solicitud.</li>
            <li>Verificación en dos pasos (TOTP) opcional con códigos de recuperación; límite de intentos persistente en la base de datos.</li><li>Bloqueo con huella (WebAuthn) exigido por el servidor: sin desbloqueo reciente la API no entrega datos.</li><li><b>Pendiente:</b> inicio de sesión solo con passkey y cifrado de la base de datos en disco. HTTPS depende de cómo despliegues el servidor.</li>
          </ul></section>
      </div>
      {sheet && <DataSheet kind={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
