import { useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, toast, useAction, useApi } from '../ui';

const KINDS = [['problem', 'Algo falla'], ['idea', 'Tengo una idea'], ['other', 'Otro comentario']] as const;
const KIND_LABEL: Record<string, string> = { problem: 'Problema', idea: 'Idea', other: 'Comentario' };
const STATUS: Record<string, [string, string]> = { new: ['Nuevo', 'warn'], seen: ['Visto', ''], done: ['Resuelto', 'teal'] };

// Pantalla desde la que se llegó (para saber dónde ocurrió un problema) y dispositivo, sin datos personales.
const lastScreen = () => { try { return sessionStorage.getItem('nova_prev_route') ?? ''; } catch { return ''; } };
const device = () => `${navigator.userAgent.match(/(Android|iPhone|iPad|Windows|Mac OS X|Linux)[^;)]*/)?.[0] ?? 'Desconocido'} · ${window.innerWidth}×${window.innerHeight}${matchMedia('(display-mode: standalone)').matches ? ' · instalada' : ''}`;

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="row" role="radiogroup" aria-label="¿Qué tanto te gusta la app?" style={{ gap: 6 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} de 5`} onClick={() => onChange(value === n ? 0 : n)}
          style={{ fontSize: 30, lineHeight: 1, background: 'none', border: 0, cursor: 'pointer', color: n <= value ? 'var(--lime)' : 'var(--faint, #4b5563)', padding: 2 }}>★</button>
      ))}
    </div>
  );
}

function Item({ f, admin }: { f: any; admin: boolean }) {
  const [reply, setReply] = useState(f.reply ?? ''); const [run, busy] = useAction();
  const [label, tone] = STATUS[f.status] ?? STATUS.new;
  return (
    <div className="card flat" style={{ display: 'grid', gap: 8 }}>
      <div className="row between wrap" style={{ gap: 6 }}>
        <span className="small"><b>{KIND_LABEL[f.kind]}</b>{admin && f.author ? ` · ${f.author}` : ''}{f.rating ? ` · ${'★'.repeat(f.rating)}` : ''}</span>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{f.message}</div>
      <div className="xs faint">{dateTime(f.created_at)}{f.screen ? ` · pantalla ${f.screen}` : ''}{admin && f.device ? ` · ${f.device}` : ''}</div>
      {f.reply && !admin && <div className="alert info"><Icon name="info" size={18} /><div className="small"><b>Respuesta:</b> {f.reply}</div></div>}
      {admin && (
        <>
          <Field id={`r-${f.id}`} label="Respuesta (la persona la verá como aviso)"><textarea id={`r-${f.id}`} className="input" rows={2} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
          <div className="row wrap" style={{ gap: 6 }}>
            {reply.trim() !== (f.reply ?? '') && <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.patch(`/api/feedback/${f.id}`, { reply: reply.trim() || null, status: f.status === 'new' ? 'seen' : undefined }), 'Respuesta enviada')}>Responder</button>}
            {f.status !== 'seen' && <button className="btn sm" disabled={busy} onClick={() => run(() => api.patch(`/api/feedback/${f.id}`, { status: 'seen' }))}>Marcar visto</button>}
            {f.status !== 'done' && <button className="btn sm" disabled={busy} onClick={() => run(() => api.patch(`/api/feedback/${f.id}`, { status: 'done' }), 'Marcado como resuelto')}>Resuelto</button>}
          </div>
        </>
      )}
    </div>
  );
}

export function Feedback() {
  const { data, loading, error, reload } = useApi<any>('/api/feedback');
  const [kind, setKind] = useState<string>('problem'); const [msg, setMsg] = useState(''); const [rating, setRating] = useState(0);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [run, busy] = useAction();
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={4} />;
  const send = async () => {
    const r = await run(() => api.post('/api/feedback', { kind, message: msg.trim(), rating: rating || null, screen: lastScreen() || null, device: device() }));
    if (r) { setMsg(''); setRating(0); toast('¡Gracias! Tu comentario llegó al administrador.', 'ok'); }
  };
  const items = (data.items as any[]).filter((f) => !data.is_admin || filter === 'all' || f.status !== 'done');
  return (
    <div className="stack">
      <h1>Comentarios y sugerencias</h1>
      <p className="muted small" style={{ margin: 0 }}>La app está en etapa de prueba. Cuéntanos qué falla, qué te confunde o qué te gustaría que tuviera. No incluyas contraseñas ni números completos de tarjeta.</p>
      <section className="card">
        <h2>Enviar un comentario</h2>
        <div className="chips" role="group" aria-label="Tipo de comentario">{KINDS.map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
        <Field id="fb" label={kind === 'problem' ? '¿Qué pasó? ¿Qué estabas haciendo?' : kind === 'idea' ? '¿Qué te gustaría que hiciera la app?' : 'Tu comentario'}>
          <textarea id="fb" className="input" rows={4} maxLength={2000} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={kind === 'problem' ? 'Ej.: al guardar un gasto con mi tarjeta BAC me salió un error…' : 'Ej.: me gustaría poder…'} />
        </Field>
        <div className="field"><span className="lbl">¿Qué tanto te gusta la app hasta ahora? (opcional)</span><Stars value={rating} onChange={setRating} /></div>
        <button className="btn primary" disabled={busy || msg.trim().length < 3} onClick={send}><Icon name="send" size={16} />Enviar</button>
      </section>
      <section className="card">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>{data.is_admin ? 'Bandeja de comentarios' : 'Mis comentarios'}</h2>
          {data.is_admin && <div className="seg" role="tablist" aria-label="Filtro"><button role="tab" aria-selected={filter === 'open'} onClick={() => setFilter('open')}>Pendientes ({(data.counts?.new ?? 0) + (data.counts?.seen ?? 0)})</button><button role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>Todos</button></div>}
        </div>
        {!items.length ? <Empty icon="check" title={data.is_admin ? 'Sin comentarios pendientes' : 'Aún no has enviado comentarios'} text={data.is_admin ? 'Cuando alguien escriba, te llegará un aviso.' : 'Lo que envíes aparecerá aquí, con la respuesta del administrador.'} />
          : <div className="stack" style={{ gap: 10, marginTop: 12 }}>{items.map((f) => <Item key={f.id} f={f} admin={data.is_admin} />)}</div>}
      </section>
    </div>
  );
}
