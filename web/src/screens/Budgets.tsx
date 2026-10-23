import { useState } from 'react';
import { api } from '../api';
import { NATURE_LABEL, money, toMinor, fromMinor } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, Progress, Sheet, confirmDialog, useAction, useApi } from '../ui';

function BudgetForm({ b, cats, onClose }: { b?: any; cats: any[]; onClose: () => void }) {
  const [cat, setCat] = useState(b?.category_id ?? ''); const [period, setPeriod] = useState(b?.period ?? 'monthly'); const [amount, setAmount] = useState(b ? fromMinor(b.amount) : '');
  const [err, setErr] = useState(''); const [run, busy] = useAction();
  return (
    <Sheet title={b ? 'Editar presupuesto' : 'Nuevo presupuesto'} onClose={onClose}>
      <Field id="bcat" label="Categoría"><select id="bcat" className="input" value={cat} disabled={Boolean(b)} onChange={(e) => setCat(e.target.value)}><option value="">Elige…</option>{cats.filter((c) => !c.parent_id && c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <div className="seg" style={{ marginBottom: 14 }} role="group" aria-label="Período"><button aria-pressed={period === 'monthly'} onClick={() => setPeriod('monthly')} disabled={Boolean(b)}>Mensual</button><button aria-pressed={period === 'weekly'} onClick={() => setPeriod('weekly')} disabled={Boolean(b)}>Semanal</button></div>
      <Field id="bam" label="Límite" error={err}><input id="bam" className="input amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <p className="hint">Incluye las subcategorías. Recibirás avisos al 50, 75, 90 y 100 %.</p>
      <button className="btn primary block" disabled={busy} onClick={() => { const m = toMinor(amount); if (!cat) return setErr('Elige una categoría'); if (!m || m <= 0) return setErr('Escribe un límite mayor que cero'); run(() => api.put('/api/budgets', { category_id: cat, period, amount: m }), 'Presupuesto guardado').then((r) => r && onClose()); }}>Guardar</button>
    </Sheet>
  );
}

function TransferForm({ budgets, onClose }: { budgets: any[]; onClose: () => void }) {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [amount, setAmount] = useState(''); const [run, busy] = useAction();
  const fb = budgets.find((b) => b.id === from);
  return (
    <Sheet title="Mover presupuesto entre categorías" onClose={onClose}>
      <Field id="tf" label="De"><select id="tf" className="input" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Elige…</option>{budgets.map((b) => <option key={b.id} value={b.id}>{b.category_name} ({b.period === 'monthly' ? 'mensual' : 'semanal'}) · sobran {money(Math.max(b.remaining, 0))}</option>)}</select></Field>
      <Field id="tt" label="A"><select id="tt" className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Elige…</option>{budgets.filter((b) => b.id !== from && (!fb || b.period === fb.period)).map((b) => <option key={b.id} value={b.id}>{b.category_name}</option>)}</select></Field>
      <Field id="ta" label="Importe"><input id="ta" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <button className="btn primary block" disabled={busy || !from || !to} onClick={() => { const m = toMinor(amount); if (!m) return; run(() => api.post('/api/budgets/transfer', { from_id: from, to_id: to, amount: m }), 'Presupuesto movido').then((r) => r && onClose()); }}>Mover</button>
    </Sheet>
  );
}

export function Budgets() {
  const { data: budgets, loading, error, reload } = useApi<any[]>('/api/budgets');
  const { data: cats } = useApi<any[]>('/api/categories');
  const { data: ins } = useApi<any>('/api/budgets/insights');
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [move, setMove] = useState(false);
  const [run] = useAction();
  if (error && !budgets) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !budgets) return <LoadingBlock rows={5} />;
  const lvl = (b: any) => (b.level >= 100 ? 'Superado' : b.level >= 90 ? '90 %' : b.level >= 75 ? '75 %' : b.level >= 50 ? '50 %' : '');
  const natTotal = (ins?.nature ?? []).reduce((s: number, n: any) => s + n.total, 0);
  const section = (period: string, title: string) => {
    const list = (budgets ?? []).filter((b) => b.period === period);
    if (!list.length) return null;
    return (
      <section className="card"><h2>{title}</h2>
        <div className="stack">{list.map((b) => (
          <div key={b.id}>
            <div className="row between"><button className="btn ghost sm" style={{ padding: 0, minHeight: 32, fontWeight: 700 }} onClick={() => setEdit(b)}>{b.category_name}</button><span className="num small">{money(b.spent)} / {money(b.amount)}</span></div>
            <Progress pct={b.pct} />
            <div className="row between xs muted" style={{ marginTop: 4 }}><span>{b.pct}% consumido{lvl(b) ? ` · umbral ${lvl(b)}` : ''}</span><span className={b.remaining < 0 ? 'neg' : ''}>{b.remaining >= 0 ? `Quedan ${money(b.remaining)}` : `Excedido ${money(-b.remaining)}`} · proyección {money(b.projected)}</span></div>
            <div className="row" style={{ marginTop: 4 }}><span className="badge">{NATURE_LABEL[b.nature]}</span><button className="btn sm ghost" onClick={async () => { if (await confirmDialog(`Se eliminará el presupuesto de ${b.category_name}. Tus movimientos no cambian.`, 'Eliminar')) run(() => api.del(`/api/budgets/${b.id}`), 'Presupuesto eliminado'); }}>Eliminar</button></div>
          </div>))}</div></section>
    );
  };
  return (
    <div className="stack">
      <div className="row between"><h1>Presupuestos</h1><div className="row"><button className="btn sm" onClick={() => setMove(true)} disabled={(budgets?.length ?? 0) < 2}>Mover</button><button className="btn primary sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Nuevo</button></div></div>
      {!budgets?.length ? <section className="card"><Empty icon="pie" title="Aún no tienes presupuestos" text="Pon un límite mensual o semanal a las categorías donde más quieres controlar." action={<button className="btn primary" onClick={() => setEdit('new')}>Crear presupuesto</button>} /></section> : <>
        {section('monthly', 'Mensuales')}{section('weekly', 'Semanales')}
      </>}
      {ins && (
        <section className="card">
          <h2>Recomendaciones</h2>
          {ins.recommendations.length ? <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{ins.recommendations.map((r: string, i: number) => <li key={i} className="small">{r}</li>)}</ul> : <p className="muted small" style={{ margin: 0 }}>Sin recomendaciones por ahora. Se calculan con tu ritmo de gasto y el mes anterior (llevas el {ins.elapsed}% del mes).</p>}
          {natTotal > 0 && <><div className="hr" /><h3 style={{ marginBottom: 8 }}>Esenciales, discrecionales y extraordinarios</h3>
            <div className="stack" style={{ gap: 8 }}>{ins.nature.map((n: any) => <div key={n.nature}><div className="row between small"><span>{NATURE_LABEL[n.nature]}</span><span className="num">{money(n.total)} · {Math.round((n.total / natTotal) * 100)}%</span></div><Progress pct={(n.total / natTotal) * 100} tone={undefined} /></div>)}</div></>}
        </section>
      )}
      {edit && <BudgetForm b={edit === 'new' ? undefined : edit} cats={cats ?? []} onClose={() => setEdit(null)} />}
      {move && <TransferForm budgets={budgets ?? []} onClose={() => setMove(false)} />}
    </div>
  );
}
