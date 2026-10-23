import { useRef, useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { Field, Sheet, Switch, confirmDialog, nav, toast, toastError, useAction, useApi } from '../ui';

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

export function Profile({ me }: { me: any }) {
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
        <Link to="/recurrentes" icon="repeat" label="Pagos recurrentes" sub="Suscripciones, facturas y servicios" /><Link to="/informes" icon="chart" label="Informes" sub="Estados, flujo de caja y exportación" /><Link to="/integraciones" icon="plug" label="Integraciones" sub="Correo, notificaciones y extractos" /><Link to="/revision" icon="check" label="Revisión de movimientos" sub="Detectados e importados" />
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
          <p className="hint">Cada hecho avisa una sola vez. Hoy las alertas aparecen dentro de la app; las notificaciones push requieren una fase posterior.</p>
        </section>
      </div>
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
          <Field id="cp" label="Contraseña actual"><input id="cp" type="password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
          <Field id="np" label="Nueva contraseña (mín. 10)"><input id="np" type="password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <button className="btn" disabled={busy || pw.next.length < 10} onClick={async () => { const r = await run(() => api.post('/api/me/password', { current: pw.current, next: pw.next }), 'Contraseña cambiada; otras sesiones cerradas'); if (r) setPw({ current: '', next: '' }); }}>Cambiar contraseña</button>
          <div className="hr" /><h3>Sesiones activas</h3>
          {sessions?.map((s, i) => <div key={i} className="xs muted" style={{ overflowWrap: 'anywhere' }}>{dateTime(s.created_at)} · {s.user_agent?.slice(0, 60) || 'dispositivo'}</div>)}
          <div className="hr" /><button className="btn" onClick={async () => { await api.post('/api/auth/logout').catch(toastError); location.reload(); }}><Icon name="logout" size={18} />Cerrar sesión</button>
        </section>
        <section className="card"><h2>Qué protege realmente esta app</h2>
          <ul className="small muted" style={{ paddingLeft: 18, display: 'grid', gap: 5, margin: 0 }}>
            <li>Contraseña con scrypt; sesión en cookie HttpOnly (el token se guarda con hash).</li><li>Cada consulta se filtra por tu usuario en el servidor; hay pruebas automáticas de aislamiento.</li>
            <li>Validación de entradas, protección CSRF, límite de intentos de acceso y cabeceras de seguridad (CSP).</li><li>Los saldos se calculan desde los movimientos; nada se borra en silencio y todo cambio queda auditado.</li>
            <li>Tokens de Google cifrados en reposo (AES-256-GCM) y solo en el servidor. No guardamos claves bancarias.</li><li>Los registros técnicos no incluyen importes, comercios ni cuerpos de solicitud.</li>
            <li><b>Pendiente:</b> verificación en dos pasos (2FA), cifrado de la base de datos en disco y notificaciones push. HTTPS depende de cómo despliegues el servidor.</li>
          </ul></section>
      </div>
      {sheet && <DataSheet kind={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
