import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { ErrorBlock, Field, LoadingBlock, Sheet, confirmDialog, nav, toast, toastError, useAction, useApi, useRoute } from '../ui';

function Status({ ok, label }: { ok: boolean | 'warn'; label: string }) { return <span className={`badge ${ok === true ? 'teal' : ok === 'warn' ? 'warn' : ''}`}>{label}</span>; }

function GmailCard({ g, accounts }: { g: any; accounts: any[] }) {
  const [run, busy] = useAction();
  const [senders, setSenders] = useState((g.config?.senders ?? []).join(', ')); const [label, setLabel] = useState(g.config?.label ?? ''); const [acc, setAcc] = useState(g.config?.default_account_id ?? accounts[0]?.id ?? '');
  const { query } = useRoute();
  useEffect(() => { const s = query.get('gmail'); if (s === 'ok') toast('Gmail conectado. Elige la cuenta destino y los remitentes.', 'ok'); if (s === 'error') toast('No se pudo completar la conexión con Gmail.', 'error'); }, []); // eslint-disable-line
  if (!g.configured) {
    return (
      <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>Correo (Gmail)</h2><Status ok={false} label="No configurado" /></div>
        <p className="small muted">Lee solo confirmaciones de compras y avisos de tu banco, con permiso de <b>solo lectura</b>. No envía ni modifica correos y no guarda el contenido de los mensajes. <b>Aún no está conectado</b>: faltan credenciales del servidor.</p>
        <p className="small"><b>Falta definir:</b> {g.missing.map((m: string) => <code key={m} style={{ marginRight: 6 }}>{m}</code>)}</p>
        <ol className="small muted" style={{ paddingLeft: 18, display: 'grid', gap: 4 }}>{g.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
      </section>
    );
  }
  return (
    <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>Correo (Gmail)</h2><Status ok={g.connected} label={g.connected ? 'Conectado' : g.status === 'error' ? 'Error' : 'Sin conectar'} /></div>
      {!g.connected ? (<><p className="small muted">Se abrirá la pantalla oficial de Google para que autorices el acceso de solo lectura. Nunca vemos tu contraseña.</p>
        {g.last_error && <p className="err">{g.last_error}</p>}
        <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => api.post('/api/integrations/gmail/connect')); if (r?.url) location.href = r.url; }}><Icon name="mail" size={18} />Conectar con Google</button></>) : (<>
        <p className="small muted">Cuenta: <b>{g.account_email ?? '—'}</b> · última sincronización: {g.last_sync_at ? dateTime(g.last_sync_at) : 'nunca'}</p>
        <Field id="gs" label="Remitentes a revisar (separados por comas)" hint="Ej.: alertas@tubanco.hn, notificaciones@bac.net. Sin remitentes se usa solo la búsqueda por palabras clave."><input id="gs" className="input" value={senders} onChange={(e) => setSenders(e.target.value)} /></Field>
        <div className="grid cols-2" style={{ gap: 0 }}>
          <Field id="gl" label="Etiqueta de Gmail (opcional)"><input id="gl" className="input" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field id="ga" label="Cuenta donde registrar"><select id="ga" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={busy} onClick={() => run(() => api.put('/api/integrations/gmail/config', { senders: senders.split(',').map((s: string) => s.trim()).filter(Boolean), label: label || undefined, default_account_id: acc || null }), 'Configuración guardada')}>Guardar</button>
          <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => api.post('/api/integrations/gmail/sync')); if (r) toast(`${r.scanned} correos revisados · ${r.created} nuevos por revisar · ${r.duplicates} duplicados · ${r.ignored} ignorados`, 'ok'); }}>Sincronizar ahora</button>
          <button className="btn danger" disabled={busy} onClick={async () => { if (await confirmDialog('Se revocará el acceso en Google y se borrará el token guardado. Los movimientos ya importados se conservan.', 'Desconectar')) run(() => api.del('/api/integrations/gmail'), 'Gmail desconectado'); }}>Desconectar y revocar</button>
        </div></>)}
    </section>
  );
}

function NotifCard({ n, accounts }: { n: any; accounts: any[] }) {
  const [acc, setAcc] = useState(n.ingest_account_id ?? accounts[0]?.id ?? ''); const [tok, setTok] = useState(''); const [run, busy] = useAction();
  return (
    <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>Notificaciones y SMS del banco</h2><Status ok={n.status === 'token_activo' ? true : false} label={n.status === 'token_activo' ? 'Token activo' : 'Sin configurar'} /></div>
      <p className="small muted">{n.note}</p>
      <p className="small muted">Solo funciona con apps de automatización que <b>tú</b> instales y autorices en tu teléfono; NOVA nunca lee notificaciones por su cuenta. Las rechazadas, canceladas y los códigos de seguridad se descartan; las demás llegan a “Revisión”.</p>
      <Field id="na" label="Cuenta donde registrar"><select id="na" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <div className="row wrap">
        <button className="btn primary" disabled={busy || !acc} onClick={async () => { const r = await run(() => api.post('/api/integrations/ingest-token', { account_id: acc })); if (r) setTok(r.token); }}>{n.status === 'token_activo' ? 'Regenerar token' : 'Generar token'}</button>
        {n.status === 'token_activo' && <button className="btn danger" disabled={busy} onClick={() => run(() => api.del('/api/integrations/ingest-token'), 'Token revocado')}>Revocar</button>}
      </div>
      {tok && <div className="card flat fade-in" style={{ marginTop: 12 }}><p className="small" style={{ marginTop: 0 }}>Guarda este token ahora; no se vuelve a mostrar:</p><code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>{tok}</code>
        <p className="small muted">En Tasker/MacroDroid crea una acción HTTP POST a <code>{n.endpoint}</code> con cabecera <code>Authorization: Bearer &lt;token&gt;</code>, <code>Content-Type: application/json</code> y cuerpo <code>{'{"text":"%ntext","title":"%ntitle","app":"%nappname"}'}</code> (los nombres de variables dependen de la app).</p></div>}
    </section>
  );
}

type Preview = { kind: string; header?: string[]; sample?: string[][]; mapping?: any; rows: any[]; total: number; errors: string[] };
function ImportCard({ accounts }: { accounts: any[] }) {
  const [file, setFile] = useState<{ name: string; kind: 'csv' | 'ofx'; content: string } | null>(null); const [pv, setPv] = useState<Preview | null>(null);
  const [acc, setAcc] = useState(accounts[0]?.id ?? ''); const [map, setMap] = useState<any>(null); const [run, busy] = useAction();
  const pick = async (f?: File) => {
    if (!f) return;
    if (f.size > 2.5 * 1024 * 1024) return toast('El archivo supera 2.5 MB', 'error');
    const kind = /\.(ofx|qfx)$/i.test(f.name) ? 'ofx' : 'csv';
    const content = await f.text();
    try { const p = await api.post('/api/import/preview', { kind, content, filename: f.name }); setFile({ name: f.name, kind, content }); setPv(p); setMap(p.mapping ?? null); } catch (e) { toastError(e); }
  };
  const colSel = (k: string, label: string) => pv?.header && <Field id={`m-${k}`} label={label}><select id={`m-${k}`} className="input" value={map?.[k] ?? -1} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}><option value={-1}>—</option>{pv.header.map((h, i) => <option key={i} value={i}>{h}</option>)}</select></Field>;
  const reprev = async () => { if (!file) return; try { const p = await api.post('/api/import/preview', { kind: file.kind, content: file.content }); setPv({ ...p, mapping: map }); } catch (e) { toastError(e); } };
  return (
    <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>Extractos (CSV / OFX)</h2><Status ok={true} label="Disponible" /></div>
      <p className="small muted">Descarga el extracto desde la banca en línea de tu banco e impórtalo. Funciona con cualquier banco que exporte CSV u OFX; las columnas se detectan y puedes corregirlas. Importar el mismo archivo dos veces no duplica movimientos. Todo queda “por revisar”.</p>
      <Field id="ia" label="Cuenta del extracto"><select id="ia" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <Field id="if" label="Archivo"><input id="if" type="file" accept=".csv,.ofx,.qfx,text/csv" className="input" onChange={(e) => pick(e.target.files?.[0])} /></Field>
      {pv && (
        <div className="fade-in">
          {pv.kind === 'csv' && map && <div className="grid cols-2" style={{ gap: 0 }}>{colSel('date', 'Columna de fecha')}{colSel('description', 'Descripción')}{map.amount != null && map.amount >= 0 ? colSel('amount', 'Importe (con signo)') : <>{colSel('debit', 'Débitos / cargos')}{colSel('credit', 'Créditos / abonos')}</>}</div>}
          {pv.kind === 'csv' && <label className="switch"><span>Fechas día/mes/año (formato habitual en Honduras)</span><input type="checkbox" role="switch" checked={map?.dayFirst !== false} onChange={(e) => setMap({ ...map, dayFirst: e.target.checked })} /></label>}
          {pv.kind === 'csv' && <button className="btn sm" onClick={reprev}>Actualizar vista previa</button>}
          <p className="small"><b>{pv.total}</b> movimiento(s) legibles{pv.errors.length ? ` · ${pv.errors.length}+ filas ignoradas` : ''}.</p>
          {pv.rows.length > 0 && <div className="scroll-x"><table className="tbl"><thead><tr><th>Fecha</th><th>Descripción</th><th className="r">Importe</th></tr></thead><tbody>{pv.rows.slice(0, 5).map((r, i) => <tr key={i}><td>{r.date}</td><td>{r.description}</td><td className="r">{(r.amount / 100).toFixed(2)}</td></tr>)}</tbody></table></div>}
          {pv.errors.slice(0, 3).map((e, i) => <div key={i} className="xs err">{e}</div>)}
          <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy || !acc || !pv.total} onClick={async () => { const r = await run(() => api.post('/api/import/commit', { kind: file!.kind, content: file!.content, filename: file!.name, account_id: acc, mapping: pv.kind === 'csv' ? map : undefined })); if (r) { toast(`${r.created_rows} nuevos · ${r.duplicate_rows} ya existían · ${r.skipped_rows} omitidos`, 'ok'); setPv(null); setFile(null); nav('/revision'); } }}>Importar y revisar</button>
        </div>)}
    </section>
  );
}

export function Integrations() {
  const { data, loading, error, reload } = useApi<any>('/api/integrations');
  const { data: accounts } = useApi<any[]>('/api/accounts');
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={6} />;
  const acc = accounts ?? [];
  return (
    <div className="stack">
      <h1>Integraciones</h1>
      <p className="muted small" style={{ margin: 0 }}>NOVA funciona al 100 % con registro manual. Estos métodos reducen el trabajo, pero siempre pasan por tu revisión antes de afectar saldos. Aquí te decimos con honestidad qué está disponible y qué no.</p>
      <div className="grid cols-2">
        <GmailCard g={data.gmail} accounts={acc} />
        <NotifCard n={data.notifications} accounts={acc} />
        <ImportCard accounts={acc} />
        <div className="stack">
          <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>API bancaria directa</h2><Status ok={false} label="No disponible" /></div><p className="small muted">{data.bank_api.reason}</p></section>
          <section className="card"><div className="row between"><h2 style={{ margin: 0 }}>Google Pay / Wallet</h2><Status ok={false} label="Sin API pública" /></div><p className="small muted">{data.google_pay.reason}</p></section>
          {data.imports.length > 0 && <section className="card"><h2>Últimas importaciones</h2><div className="stack" style={{ gap: 6 }}>{data.imports.map((i: any) => <div key={i.id} className="row between small"><span>{i.filename ?? i.kind}</span><span className="muted">{i.created_rows} nuevos · {i.duplicate_rows} dup. · {dateTime(i.created_at)}</span></div>)}</div></section>}
        </div>
      </div>
    </div>
  );
}
