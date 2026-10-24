import { useState } from 'react';
import { api } from '../api';
import { useBrand } from '../brand';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, confirmDialog, toast, useAction, useApi } from '../ui';

export function Share() {
  const brand = useBrand();
  const { data, loading, error, reload } = useApi<any>('/api/invites');
  const [uses, setUses] = useState('5'); const [days, setDays] = useState('7'); const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [run, busy] = useAction();
  if (error?.status === 403) return <div className="stack"><h1>Compartir app</h1><section className="card"><Empty icon="send" title="Solo el administrador puede invitar" text="Pídele a quien administra la app que te envíe un enlace de invitación para otras personas." /></section></div>;
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={4} />;
  const message = (url: string) => `Te invito a probar ${brand.app_name}, mi app de finanzas personales. Crea tu cuenta aquí: ${url}`;
  const create = async () => {
    const r = await run(() => api.post('/api/invites', { max_uses: Number(uses), days: Number(days), note: note.trim() || undefined }), 'Invitación creada');
    if (r) { setLink(r.url); setNote(''); }
  };
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast('Enlace copiado', 'ok'); } catch { toast('No se pudo copiar: mantén presionado el enlace para copiarlo', 'error'); } };
  const share = async (url: string) => {
    if (navigator.share) { try { await navigator.share({ title: brand.app_name, text: message(url), url }); } catch { /* cancelado */ } }
    else copy(message(url));
  };
  return (
    <div className="stack">
      <h1>Compartir app</h1>
      <p className="muted small" style={{ margin: 0 }}>Crea un enlace de invitación para que amigos y familiares prueben la app. Cada persona tiene su propia cuenta y solo ve sus datos. Hay {data.users} cuenta(s) en esta instalación.</p>
      <section className="card">
        <h2>Nueva invitación</h2>
        <div className="grid cols-3" style={{ gap: 0 }}>
          <Field id="iu" label="¿Cuántas personas?"><select id="iu" className="input" value={uses} onChange={(e) => setUses(e.target.value)}>{[1, 3, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field id="id" label="Vence en"><select id="id" className="input" value={days} onChange={(e) => setDays(e.target.value)}>{[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} día(s)</option>)}</select></Field>
          <Field id="in" label="Nota (opcional)"><input id="in" className="input" value={note} maxLength={80} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: Familia" /></Field>
        </div>
        <button className="btn primary" disabled={busy} onClick={create}><Icon name="plus" size={16} />Crear enlace</button>
        {link && (
          <div className="card flat fade-in" style={{ marginTop: 14 }}>
            <p className="small" style={{ marginTop: 0 }}><b>Tu enlace</b> (cópialo ahora: por seguridad no se vuelve a mostrar):</p>
            <code style={{ display: 'block', padding: 10, userSelect: 'all' }}>{link}</code>
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button className="btn primary sm" onClick={() => share(link)}><Icon name="send" size={16} />Compartir</button>
              <a className="btn sm" href={`https://wa.me/?text=${encodeURIComponent(message(link))}`} target="_blank" rel="noreferrer">WhatsApp</a>
              <button className="btn sm" onClick={() => copy(link)}>Copiar</button>
            </div>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Invitaciones</h2>
        {!data.invites.length ? <p className="muted small" style={{ margin: 0 }}>Aún no has creado invitaciones.</p> : (
          <div className="list">{data.invites.map((i: any) => (
            <div key={i.id} className="item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <span className="avatar mv"><Icon name="send" /></span>
              <div className="grow">
                <div className="t">{i.note || 'Invitación'} <span className={`badge ${i.active ? 'teal' : ''}`}>{i.revoked ? 'Revocada' : i.active ? 'Activa' : 'Terminada'}</span></div>
                <div className="s">{i.uses} de {i.max_uses} usos · vence {dateTime(i.expires_at)}</div>
                {i.joined?.length > 0 && <div className="xs muted">Se unieron: {i.joined.map((j: any) => j.name).join(', ')}</div>}
              </div>
              {i.active && <button className="btn sm ghost" onClick={async () => { if (await confirmDialog('El enlace dejará de funcionar. Las cuentas ya creadas siguen activas.', 'Revocar')) run(() => api.del(`/api/invites/${i.id}`), 'Invitación revocada').then(reload); }}>Revocar</button>}
            </div>
          ))}</div>
        )}
      </section>
      <section className="card">
        <h2>Antes de compartir</h2>
        <ul className="small muted" style={{ paddingLeft: 18, display: 'grid', gap: 5, margin: 0 }}>
          <li>Cada persona ve solo sus datos dentro de la app, pero tú, como dueño del servidor y de la base de datos (Supabase), podrías técnicamente acceder a ellos. Avísales que es una versión de prueba.</li>
          <li>Pídeles que no usen contraseñas que ya usen en otros sitios y que no registren datos que no quieran compartir en una prueba.</li>
          <li><b>Gmail:</b> mientras la conexión de Google esté en modo «Prueba», solo pueden vincular su correo las personas que agregues como <b>usuarios de prueba</b> en <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Google Cloud → Público</a> (máx. 100). Agrega su Gmail antes de enviarles el enlace; Google les pedirá volver a vincular cada 7 días.</li>
          <li>Para que cada aviso del banco caiga en la tarjeta correcta, que escriban los <b>últimos 4 dígitos</b> al crear cada tarjeta o cuenta.</li>
          <li>Pídeles que usen <b>Perfil → Comentarios y sugerencias</b> para contarte qué falla o qué mejorarían; te llegará un aviso.</li>
          <li>El plan gratuito de Render y Supabase está pensado para pocos usuarios: bien para un grupo de prueba.</li>
        </ul>
      </section>
    </div>
  );
}
