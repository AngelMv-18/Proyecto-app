import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PAY_METHODS, isoLocalInput, money, toMinor } from '../format';
import { Icon } from '../icons';
import { Field, LoadingBlock, Progress, toastError, useApi, useIsAdmin } from '../ui';

/** Negritas **así** en las respuestas (sin interpretar HTML). */
const rich = (text: string) => text.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p));

type Msg = { role: 'user' | 'assistant'; content: string; meta?: string };
const SUGGESTIONS = ['¿Cuánto puedo gastar esta semana?', '¿En qué categoría estoy gastando más?', '¿Qué gastos puedo reducir?', '¿Qué cambió respecto al mes anterior?', '¿Cómo voy con mis metas?', '¿Cuánto me quedará después de mis compromisos?'];

function Chat() {
  const { data: st } = useApi<any>('/api/ai/status');
  const admin = useIsAdmin();
  const [msgs, setMsgs] = useState<Msg[]>([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);
  const send = async (q: string) => {
    const content = q.trim(); if (!content || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content }];
    setMsgs(next); setText(''); setBusy(true);
    try {
      const r = await api.post('/api/ai/chat', { messages: next.map(({ role, content }) => ({ role, content })) });
      setMsgs([...next, { role: 'assistant', content: r.answer, meta: admin ? `${r.mode === 'llm' ? 'Modelo de lenguaje' : 'Modo local (reglas)'}${r.tools_used.length ? ` · consultó: ${r.tools_used.join(', ')}` : ''}` : undefined }]);
    } catch (e) { toastError(e); setMsgs(next); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      {admin && st && <div className={`alert ${st.llm_configured ? 'info' : ''}`}><Icon name="shield" size={20} /><div className="small"><b>Solo tú lo ves (administrador):</b> {st.privacy}</div></div>}
      <section className="card" aria-live="polite">
        {!msgs.length && <div><h2>Pregúntale a NOVA</h2><div className="chips" style={{ flexWrap: 'wrap' }}>{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)} style={{ whiteSpace: 'normal', textAlign: 'left', padding: '8px 14px' }}>{s}</button>)}</div></div>}
        <div className="chat">
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role === 'user' ? 'user' : 'bot'}`}>{m.role === 'user' ? m.content : rich(m.content)}{m.meta && <div className="xs faint" style={{ marginTop: 6 }}>{m.meta}</div>}</div>
          ))}
          {busy && <div className="bubble bot" aria-busy="true"><span className="muted">NOVA está calculando…</span></div>}
          <div ref={end} />
        </div>
      </section>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(text); }} style={{ position: 'sticky', bottom: 'calc(var(--nav-h) + 8px)' }}>
        <input className="input" aria-label="Escribe tu pregunta" placeholder="Ej.: ¿Puedo permitirme una compra de 3,000 HNL?" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
        <button className="btn primary" disabled={busy || !text.trim()} aria-label="Enviar"><Icon name="send" size={20} /></button>
      </form>
    </div>
  );
}

const VERDICT_ICON: Record<string, string> = { compatible: 'check', plan: 'info', delays_goal: 'target', risk_obligations: 'warn' };

export function Evaluator() {
  const { data: cats } = useApi<any[]>('/api/categories');
  const { data: goals } = useApi<any[]>('/api/goals');
  const [f, setF] = useState({ item: '', price: '', extra: '', payment: 'cash', installments: '6', total: '', kind: 'want', date: '', category_id: '', goal_id: '' });
  const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const price = toMinor(f.price); const fe: Record<string, string> = {};
    if (!f.item.trim()) fe.item = 'Indica qué quieres comprar'; if (!price || price <= 0) fe.price = 'Escribe el precio';
    setErr(fe); if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      setRes(await api.post('/api/purchase/evaluate', { item: f.item.trim(), price, extra_costs: toMinor(f.extra) ?? 0, payment: f.payment, installments: f.payment === 'installments' ? Number(f.installments) || 1 : undefined, installments_total: f.payment === 'installments' && toMinor(f.total) ? toMinor(f.total) : undefined, kind: f.kind, date: f.date || undefined, category_id: f.category_id || null, goal_id: f.goal_id || null }));
    } catch (er) { toastError(er); } finally { setBusy(false); }
  };
  return (
    <div className="grid dash">
      <form className="card" onSubmit={submit} noValidate>
        <h2>¿Me conviene comprarlo?</h2>
        <Field id="pi" label="¿Qué quieres comprar?" error={err.item}><input id="pi" className="input" value={f.item} onChange={(e) => set('item', e.target.value)} placeholder="Ej.: Teléfono nuevo" /></Field>
        <div className="grid cols-2" style={{ gap: 0 }}>
          <Field id="pp" label="Precio" error={err.price}><input id="pp" className="input" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
          <Field id="pe" label="Otros gastos asociados" hint="Funda, envío, impuestos…"><input id="pe" className="input" inputMode="decimal" value={f.extra} onChange={(e) => set('extra', e.target.value)} /></Field>
        </div>
        <div className="field"><span className="lbl">Forma de pago</span><div className="chips" role="group" aria-label="Forma de pago">{[['cash', 'Efectivo'], ['debit', 'Débito'], ['credit', 'Crédito'], ['installments', 'Cuotas']].map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.payment === k} onClick={() => set('payment', k)}>{l}</button>)}</div></div>
        {f.payment === 'installments' && <div className="grid cols-2" style={{ gap: 0 }}><Field id="pn" label="Número de cuotas"><input id="pn" className="input" inputMode="numeric" value={f.installments} onChange={(e) => set('installments', e.target.value)} /></Field><Field id="pt" label="Total a pagar (con intereses)" hint="Opcional"><input id="pt" className="input" inputMode="decimal" value={f.total} onChange={(e) => set('total', e.target.value)} /></Field></div>}
        <div className="field"><span className="lbl">¿Es una necesidad o un deseo?</span><div className="seg" role="group"><button type="button" aria-pressed={f.kind === 'need'} onClick={() => set('kind', 'need')}>Necesidad</button><button type="button" aria-pressed={f.kind === 'want'} onClick={() => set('kind', 'want')}>Deseo</button></div></div>
        <div className="grid cols-2" style={{ gap: 0 }}>
          <Field id="pd" label="Fecha en que quieres comprarlo"><input id="pd" type="date" className="input" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field id="pc" label="Categoría (para ver su presupuesto)"><select id="pc" className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}><option value="">—</option>{(cats ?? []).filter((c) => !c.parent_id && c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <Field id="pg" label="Meta de ahorro prioritaria"><select id="pg" className="input" value={f.goal_id} onChange={(e) => set('goal_id', e.target.value)}><option value="">La de mayor prioridad</option>{(goals ?? []).filter((g) => g.status === 'active').map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <button className="btn primary block" disabled={busy}>{busy ? 'Evaluando…' : 'Evaluar compra'}</button>
      </form>
      <div className="stack">
        {busy && <LoadingBlock rows={5} />}
        {!res && !busy && <section className="card"><div className="empty"><Icon name="spark" size={54} /><h3>Decide con datos, no con impulso</h3><p style={{ margin: 0 }}>NOVA compara la compra con tu saldo libre, tus compromisos, tu presupuesto y tus metas. No decide por ti: te explica el porqué y te propone alternativas.</p></div></section>}
        {res && !busy && (
          <section className="stack fade-in" aria-live="polite">
            <div className={`verdict ${res.verdict}`}><div className="row"><Icon name={VERDICT_ICON[res.verdict]} size={28} /><div><div className="xs muted">Evaluación orientativa · confianza {res.confidence}</div><h2 style={{ margin: 0 }}>{res.headline}</h2></div></div></div>
            {res.warnings.map((w: string, i: number) => <div key={i} className="alert warning"><Icon name="warn" size={18} /><span className="small">{w}</span></div>)}
            <div className="card"><h3 style={{ marginBottom: 8 }}>Por qué</h3><ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{res.reasons.map((r: string, i: number) => <li key={i} className="small">{r}</li>)}</ul></div>
            <div className="card"><h3 style={{ marginBottom: 8 }}>Alternativas</h3><ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{res.alternatives.map((r: string, i: number) => <li key={i} className="small">{r}</li>)}</ul></div>
            {res.savings_plan && <div className="card"><h3 style={{ marginBottom: 6 }}>Plan de ahorro sugerido</h3><div className="num" style={{ fontSize: '1.5rem', fontWeight: 700 }}>{money(res.savings_plan.weekly)} <span className="muted small" style={{ fontFamily: 'var(--font)' }}>por semana · {res.savings_plan.weeks} semanas</span></div><div className="small muted">≈ {money(res.savings_plan.monthly)} al mes. {res.savings_plan.note}</div></div>}
            <details className="card"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Supuestos usados</summary><ul style={{ paddingLeft: 18 }}>{res.assumptions.map((r: string, i: number) => <li key={i} className="small muted">{r}</li>)}<li className="small muted">Historial analizado: {res.period.baseline_days} días.</li></ul></details>
            <p className="hint">{res.disclaimer}</p>
          </section>
        )}
      </div>
    </div>
  );
}

export function Ai() {
  const [tab, setTab] = useState<'chat' | 'buy'>(location.hash.includes('comprar') ? 'buy' : 'chat');
  return (
    <div className="stack">
      <div className="row"><h1 className="grow">NOVA AI</h1></div>
      <div className="seg" role="tablist" aria-label="Secciones de NOVA AI"><button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Asistente</button><button role="tab" aria-selected={tab === 'buy'} onClick={() => setTab('buy')}>¿Me conviene comprarlo?</button></div>
      {tab === 'chat' ? <Chat /> : <Evaluator />}
    </div>
  );
}
