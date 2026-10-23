import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';
import { ACCENTS, BG_OPTIONS, applyBrand, loadBrand, useBrand } from '../brand';
import { dateTime } from '../format';
import { Icon, Logo } from '../icons';
import { biometricSupported } from '../components/Lock';
import { Field, confirmDialog, toast, toastError, useAction, useApi } from '../ui';

/** Recorta la imagen al centro (cuadrado) y la convierte a PNG del tamaño pedido. */
async function toPng(file: File, size: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

function BrandEditor() {
  const b = useBrand();
  const [name, setName] = useState(b.app_name);
  const [accent, setAccent] = useState(b.accent);
  const [bg, setBg] = useState(b.background);
  const [run, busy] = useAction();
  useEffect(() => { setName(b.app_name); setAccent(b.accent); setBg(b.background); }, [b.app_name, b.accent, b.background]);
  // Vista previa en vivo: se aplica al instante y se revierte si sales sin guardar.
  useEffect(() => { applyBrand({ accent, background: bg, app_name: name.trim() || b.app_name }); }, [accent, bg, name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { loadBrand(); }, []);
  if (!b.is_admin) return <p className="muted small">Solo el administrador de esta instalación (la primera cuenta creada) puede cambiar la apariencia.</p>;
  const save = () => run(async () => { await api.put('/api/appearance', { app_name: name.trim() || 'NOVA FINANCE', accent, background: bg }); await loadBrand(); }, 'Apariencia guardada');
  const onLogo = async (f?: File) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast('Usa una imagen PNG, JPG o WebP', 'error');
    if (f.size > 8 * 1024 * 1024) return toast('La imagen supera 8 MB', 'error');
    try {
      const [png192, png512] = await Promise.all([toPng(f, 192), toPng(f, 512)]);
      await run(async () => { await api.put('/api/appearance/logo', { png192, png512 }); await loadBrand(); }, 'Logotipo actualizado');
    } catch (e) { toastError(e); }
  };
  return (
    <div>
      <div className="card flat" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}><Logo size={44} /></div>
      <Field id="bn" label="Nombre de la app" hint="Se ve en el encabezado, en la pantalla de acceso y al instalarla en el teléfono."><input id="bn" className="input" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="field"><span className="lbl">Color principal</span>
        <div className="swatches" role="group" aria-label="Color principal">
          {ACCENTS.map(([n, c]) => <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={n} aria-pressed={accent.toLowerCase() === c.toLowerCase()} onClick={() => setAccent(c)} />)}
          <label className="swatch" style={{ display: 'grid', placeItems: 'center', background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} aria-label="Color personalizado">
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value.toUpperCase())} style={{ opacity: 0, width: 1, height: 1 }} />
          </label>
        </div>
      </div>
      <div className="field"><span className="lbl">Fondo</span>
        <div className="grid cols-3" style={{ gap: 8 }}>{BG_OPTIONS.map((o) => <button key={o.id} type="button" className="bgopt" style={{ background: `linear-gradient(135deg, ${o.color}, ${o.color} 60%, color-mix(in srgb, ${o.color} 70%, #fff 8%))` }} aria-pressed={bg === o.id} onClick={() => setBg(o.id)}>{o.name}</button>)}</div>
      </div>
      <div className="field"><span className="lbl">Logotipo</span>
        <div className="row wrap">
          <label className="btn sm"><Icon name="upload" size={16} />Subir imagen<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onLogo(e.target.files?.[0])} /></label>
          {b.has_logo && <button className="btn sm ghost" onClick={() => run(async () => { await api.del('/api/appearance/logo'); await loadBrand(); }, 'Logotipo restablecido')}>Quitar logotipo</button>}
        </div>
        <span className="hint">Se recorta al centro en forma cuadrada. También será el ícono en la pantalla de inicio del teléfono (si ya la instalaste, quítala y vuelve a instalarla para ver el nuevo ícono).</span>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={save}>Guardar apariencia</button>
        <button className="btn ghost" disabled={busy} onClick={async () => { if (await confirmDialog('Se volverá al nombre, colores y logotipo originales de NOVA FINANCE.', 'Restablecer')) run(async () => { await api.del('/api/appearance'); await loadBrand(); }, 'Apariencia restablecida'); }}>Restablecer</button>
      </div>
    </div>
  );
}

export function BiometricLock() {
  const { data: st, reload } = useApi<any>('/api/lock/status');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [run, busy] = useAction();
  useEffect(() => { biometricSupported().then(setSupported); }, []);
  if (!st) return null;
  const register = () => run(async () => {
    const opts = await api.post('/api/lock/register/options');
    let resp;
    try { resp = await startRegistration({ optionsJSON: opts }); }
    catch (e: any) { throw new Error(e?.name === 'NotAllowedError' ? 'Se canceló el registro de la huella' : e?.name === 'InvalidStateError' ? 'Este dispositivo ya está registrado' : e?.message ?? 'No se pudo registrar'); }
    const label = /Android/i.test(navigator.userAgent) ? 'Teléfono Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone' : 'Este dispositivo';
    await api.post('/api/lock/register/verify', { response: resp, label });
    reload();
  }, 'Huella registrada: la app pedirá tu huella al abrirse');
  return (
    <div>
      {supported === false && <div className="alert warning" style={{ marginBottom: 12 }}><Icon name="warn" size={18} /><span className="small">Este navegador o dispositivo no ofrece desbloqueo biométrico. En Android usa Chrome, con una huella o bloqueo de pantalla configurado en el teléfono.</span></div>}
      <p className="small muted" style={{ marginTop: 0 }}>Al abrir la app (o volver a ella tras el tiempo elegido) se pedirá tu huella. La huella nunca sale del teléfono: él firma un desafío y el servidor lo verifica. Mientras esté bloqueada, el servidor no entrega tus datos.</p>
      <div className="row between" style={{ margin: '8px 0' }}><span>Estado</span><span className={`badge ${st.enabled ? 'teal' : ''}`}>{st.enabled ? 'Activado' : 'Desactivado'}</span></div>
      {st.credentials.map((c: any) => (
        <div key={c.full_id} className="row between small" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span><Icon name="lock" size={14} /> {c.label} <span className="faint xs">· {c.last_used_at ? `usada ${dateTime(c.last_used_at)}` : `registrada ${dateTime(c.created_at)}`}</span></span>
          <button className="btn sm ghost" onClick={async () => { if (await confirmDialog(`Se quitará la huella de "${c.label}".${st.credentials.length === 1 ? ' Al ser la última, el bloqueo se desactivará.' : ''}`, 'Quitar')) run(() => api.del(`/api/lock/credentials/${encodeURIComponent(c.full_id)}`), 'Huella quitada').then(reload); }}>Quitar</button>
        </div>
      ))}
      <div className="row wrap" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || supported === false} onClick={register}><Icon name="lock" size={16} />{st.credentials.length ? 'Registrar otro dispositivo' : 'Activar con mi huella'}</button>
        {st.credentials.length > 0 && <button className="btn" disabled={busy} onClick={() => run(() => api.patch('/api/lock/settings', { enabled: !st.enabled }), st.enabled ? 'Bloqueo desactivado' : 'Bloqueo activado').then(reload)}>{st.enabled ? 'Desactivar bloqueo' : 'Activar bloqueo'}</button>}
      </div>
      {st.enabled && (
        <Field id="lockto" label="Pedir la huella si la app estuvo cerrada o sin usar más de">
          <select id="lockto" className="input" value={st.timeout_min} onChange={(e) => run(() => api.patch('/api/lock/settings', { timeout_min: Number(e.target.value) }), 'Tiempo de bloqueo actualizado').then(reload)}>
            <option value={1}>1 minuto</option><option value={5}>5 minutos</option><option value={15}>15 minutos</option><option value={60}>1 hora</option>
          </select>
        </Field>
      )}
    </div>
  );
}

export function Appearance() {
  return (
    <div className="stack">
      <h1>Apariencia</h1>
      <section className="card"><h2>Colores, nombre y logotipo</h2><BrandEditor /></section>
      <section className="card"><h2>Bloqueo con huella</h2><BiometricLock /></section>
    </div>
  );
}
