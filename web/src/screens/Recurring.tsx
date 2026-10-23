import { useState } from 'react';
import { api } from '../api';
import { FREQ_LABEL, fromMinor, money, toMinor, ymd } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, Sheet, confirmDialog, useAction, useApi } from '../ui';

const KINDS: Record<string, string> = { subscription: 'Suscripción', bill: 'Factura', service: 'Servicio', debt: 'Pago de deuda', other: 'Otro' };
const MULT: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12 };

function RecForm({ r, preset, accounts, cats, debts, onClose }: { r?: any; preset?: any; accounts: any[]; cats: any[]; debts: any[]; onClose: () => void }) {
  const s = r ?? preset ?? {};
  const [name, setName] = useState(s.name ?? ''); const [kind, setKind] = useState(s.kind ?? 'subscription'); const [amount, setAmount] = useState(s.amount ? fromMinor(s.amount) : '');
  const [freq, setFreq] = useState(s.frequency ?? 'monthly'); const [next, setNext] = useState(s.next_date ?? new Date().toISOString().slice(0, 10)); const [acc, setAcc] = useState(s.account_id ?? accounts[0]?.id ?? '');
  const [cat, setCat] = useState(s.category_id ?? ''); const [debt, setDebt] = useState(s.debt_id ?? ''); const [errs, setErrs] = useState<Record<string, string>>({}); const [run, busy] = useAction();
  const save = async () => {
    const m = toMinor(amount); const fe: Record<string, string> = {};
    if (!name.trim()) fe.name = 'Ponle un nombre'; if (!m || m <= 0) fe.amount = 'Indica el importe esperado';
    setErrs(fe); if (Object.keys(fe).length) return;
    const body = { name: name.trim(), kind, amount: m, frequency: freq, next_date: next, account_id: acc || null, category_id: cat || null, debt_id: kind === 'debt' && debt ? debt : null, origin: preset ? 'suggested' : 'manual' };
    const x = await run(() => r ? api.patch(`/api/recurring/${r.id}`, body) : api.post('/api/recurring', body), 'Guardado'); if (x) onClose();
  };
  return (
    <Sheet title={r ? 'Editar pago recurrente' : preset ? 'Confirmar pago recurrente sugerido' : 'Nuevo pago recurrente'} onClose={onClose}>
      {preset && <p className="small muted" style={{ marginTop: 0 }}>NOVA detectó {preset.occurrences} pagos parecidos. Revisa los datos y confirma: no se crea nada hasta que guardes.</p>}
      <Field id="rn" label="Nombre" error={errs.name}><input id="rn" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Netflix, Internet, Alquiler" /></Field>
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="rk" label="Tipo"><select id="rk" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field id="ra" label="Importe esperado" error={errs.amount}><input id="ra" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field id="rf" label="Frecuencia"><select id="rf" className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>{Object.entries(FREQ_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field id="rd" label="Próximo pago"><input id="rd" type="date" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      </div>
      <Field id="rac" label="Cuenta que se usará"><select id="rac" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">—</option>{accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      {kind === 'debt' ? <Field id="rdb" label="Deuda asociada"><select id="rdb" className="input" value={debt} onChange={(e) => setDebt(e.target.value)}><option value="">—</option>{debts.filter((d) => d.status === 'open' && d.direction === 'owe').map((d) => <option key={d.id} value={d.id}>{d.counterparty}</option>)}</select></Field>
        : <Field id="rc" label="Categoría"><select id="rc" className="input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">—</option>{cats.filter((c) => !c.parent_id && c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <button className="btn primary block" disabled={busy} onClick={save}>Guardar</button>
    </Sheet>
  );
}

export function Recurring() {
  const { data: rec, loading, error, reload } = useApi<any[]>('/api/recurring');
  const { data: sug } = useApi<any[]>('/api/recurring/suggestions');
  const { data: accounts } = useApi<any[]>('/api/accounts'); const { data: cats } = useApi<any[]>('/api/categories'); const { data: debts } = useApi<any[]>('/api/debts');
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [preset, setPreset] = useState<any>(null); const [run] = useAction();
  if (error && !rec) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !rec) return <LoadingBlock rows={4} />;
  const monthly = rec!.filter((r) => r.active).reduce((s, r) => s + r.amount * MULT[r.frequency], 0);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="stack">
      <div className="row between"><h1>Pagos recurrentes</h1><button className="btn primary sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Nuevo</button></div>
      <div className="kpi"><div className="k">Equivalente mensual estimado</div><div className="v num">{money(Math.round(monthly))}</div></div>
      {sug && sug.length > 0 && (
        <section className="card glow"><h2><span><Icon name="spark" size={18} style={{ verticalAlign: -3 }} /> NOVA detectó posibles suscripciones</span></h2>
          <div className="list">{sug.map((s, i) => <div className="item" key={i} style={{ cursor: 'default' }}><span className="avatar mv"><Icon name="repeat" /></span><div className="grow"><div className="t">{s.name}</div><div className="s">{money(s.amount)} · {FREQ_LABEL[s.frequency].toLowerCase()} · {s.occurrences} pagos</div></div><button className="btn sm" onClick={() => setPreset({ ...s, kind: 'subscription' })}>Revisar</button></div>)}</div>
          <p className="hint">Son sugerencias basadas en tus movimientos. Nada se crea sin tu confirmación.</p></section>
      )}
      {!rec!.length ? <section className="card"><Empty icon="repeat" title="Sin pagos recurrentes" text="Registra tus suscripciones, facturas y cuotas para ver cuánto tienes comprometido." action={<button className="btn primary" onClick={() => setEdit('new')}>Agregar</button>} /></section> :
        <section className="card"><div className="list">{rec!.map((r) => (
          <div className="item" key={r.id} style={{ cursor: 'default', opacity: r.active ? 1 : 0.55, alignItems: 'flex-start' }}>
            <span className="avatar mv"><Icon name="repeat" /></span>
            <div className="grow"><div className="t">{r.name}</div><div className="s">{KINDS[r.kind]} · {FREQ_LABEL[r.frequency].toLowerCase()} · próximo {ymd(r.next_date)}{r.next_date < today && r.active ? ' · vencido' : ''}</div>
              <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                {r.active && <button className="btn sm primary" onClick={() => run(() => api.post(`/api/recurring/${r.id}/pay`, {}), 'Pago registrado').catch?.(() => {})} disabled={!r.account_id} title={r.account_id ? '' : 'Asigna una cuenta para registrar el pago'}>Registrar pago</button>}
                <button className="btn sm" onClick={() => setEdit(r)}>Editar</button>
                <button className="btn sm ghost" onClick={() => run(() => api.patch(`/api/recurring/${r.id}`, { active: !r.active }))}>{r.active ? 'Pausar' : 'Reactivar'}</button>
                <button className="btn sm ghost" onClick={async () => { if (await confirmDialog(`Se eliminará "${r.name}". Los pagos ya registrados no cambian.`, 'Eliminar')) run(() => api.del(`/api/recurring/${r.id}`), 'Eliminado'); }}>Eliminar</button>
              </div></div>
            <div className="amt">{money(r.amount)}</div>
          </div>))}</div></section>}
      {(edit || preset) && <RecForm r={edit && edit !== 'new' ? edit : undefined} preset={preset} accounts={accounts ?? []} cats={cats ?? []} debts={debts ?? []} onClose={() => { setEdit(null); setPreset(null); }} />}
    </div>
  );
}
