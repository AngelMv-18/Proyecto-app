import { useState } from 'react';
import { api } from '../api';
import { dateShort, fromMinor, money, toMinor, ymd } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, Progress, Sheet, useAction, useApi } from '../ui';

function DebtForm({ accounts, onClose }: { accounts: any[]; onClose: () => void }) {
  const [dir, setDir] = useState<'owe' | 'owed'>('owe'); const [who, setWho] = useState(''); const [amount, setAmount] = useState(''); const [due, setDue] = useState(''); const [rate, setRate] = useState(''); const [notes, setNotes] = useState('');
  const [cash, setCash] = useState(''); const [errs, setErrs] = useState<Record<string, string>>({}); const [run, busy] = useAction();
  const save = async () => {
    const m = toMinor(amount); const fe: Record<string, string> = {};
    if (!who.trim()) fe.who = 'Indica la persona o entidad'; if (!m || m <= 0) fe.amount = 'Indica el importe original';
    setErrs(fe); if (Object.keys(fe).length) return;
    const r = await run(() => api.post('/api/debts', { direction: dir, counterparty: who.trim(), original_amount: m, due_date: due || null, interest_rate: rate ? Number(rate) : null, notes: notes || null, cash_account_id: cash || null }), 'Deuda registrada');
    if (r) onClose();
  };
  return (
    <Sheet title="Nueva deuda" onClose={onClose}>
      <div className="seg" style={{ marginBottom: 14 }}><button aria-pressed={dir === 'owe'} onClick={() => setDir('owe')}>Yo debo</button><button aria-pressed={dir === 'owed'} onClick={() => setDir('owed')}>Me deben</button></div>
      <Field id="dw" label={dir === 'owe' ? 'Acreedor (a quién le debo)' : 'Deudor (quién me debe)'} error={errs.who}><input id="dw" className="input" value={who} onChange={(e) => setWho(e.target.value)} /></Field>
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="da" label="Importe original" error={errs.amount}><input id="da" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field id="dd" label="Vence"><input id="dd" type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <Field id="dr" label="Interés anual % (opcional, informativo)"><input id="dr" className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      <Field id="dc" label={dir === 'owe' ? '¿El dinero prestado entró a una cuenta?' : '¿El dinero salió de una cuenta?'} hint="Si eliges una cuenta se registra ese movimiento de dinero, sin contarlo como ingreso ni gasto. Si la deuda es antigua, déjalo vacío."><select id="dc" className="input" value={cash} onChange={(e) => setCash(e.target.value)}><option value="">No registrar movimiento</option>{accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <Field id="dn" label="Notas"><textarea id="dn" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
      <button className="btn primary block" disabled={busy} onClick={save}>Guardar</button>
    </Sheet>
  );
}

function Pay({ d, accounts, onClose }: { d: any; accounts: any[]; onClose: () => void }) {
  const list = accounts.filter((a) => !a.archived && a.currency === d.currency);
  const [acc, setAcc] = useState(list[0]?.id ?? ''); const [amount, setAmount] = useState(fromMinor(d.remaining)); const [run, busy] = useAction();
  const { data: pays } = useApi<any[]>(`/api/debts/${d.id}/payments`);
  return (
    <Sheet title={d.direction === 'owe' ? `Pagar a ${d.counterparty}` : `Cobrar a ${d.counterparty}`} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>Pendiente: <b>{money(d.remaining, d.currency)}</b>. {d.direction === 'owe' ? 'El pago reduce tu deuda y tu saldo; no se cuenta como gasto de consumo.' : 'El cobro reduce lo que te deben y aumenta tu saldo; no se cuenta como ingreso.'}</p>
      <Field id="pa" label={d.direction === 'owe' ? 'Pagar desde' : 'Recibir en'}><select id="pa" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>{list.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}</select></Field>
      <Field id="pm" label="Importe"><input id="pm" className="input amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <button className="btn primary block" disabled={busy || !acc} onClick={() => { const m = toMinor(amount); if (!m || m <= 0) return; run(() => api.post(`/api/debts/${d.id}/payments`, { account_id: acc, amount: m }), 'Movimiento registrado').then((r) => r && onClose()); }}>{d.direction === 'owe' ? 'Registrar pago' : 'Registrar cobro'}</button>
      {pays && pays.length > 0 && <><h3 style={{ margin: '18px 0 6px' }}>Historial</h3><div className="stack" style={{ gap: 4 }}>{pays.map((p) => <div key={p.id} className="row between small"><span>{dateShort(p.occurred_at)}{p.status !== 'confirmed' ? ` · ${p.status}` : ''}</span><b className="num">{money(p.amount, d.currency)}</b></div>)}</div></>}
    </Sheet>
  );
}

export function Debts() {
  const { data: debts, loading, error, reload } = useApi<any[]>('/api/debts');
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const [tab, setTab] = useState<'owe' | 'owed'>('owe'); const [add, setAdd] = useState(false); const [pay, setPay] = useState<any>(null);
  if (error && !debts) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !debts) return <LoadingBlock rows={4} />;
  const open = debts!.filter((d) => d.status === 'open'), shown = open.filter((d) => d.direction === tab);
  const total = (dir: string) => open.filter((d) => d.direction === dir).reduce((s, d) => s + d.remaining, 0);
  const plan = (d: any) => {
    if (!d.due_date) return null;
    const months = Math.max((new Date(d.due_date).getTime() - Date.now()) / (30.4375 * 86400000), 0);
    if (months <= 0) return `Vencida: ${money(d.remaining, d.currency)} pendientes.`;
    return `Plan orientativo: ≈ ${money(Math.ceil(d.remaining / Math.max(months, 1)), d.currency)} al mes hasta el ${ymd(d.due_date)}.`;
  };
  return (
    <div className="stack">
      <div className="row between"><h1>Deudas y préstamos</h1><button className="btn primary sm" onClick={() => setAdd(true)}><Icon name="plus" size={16} />Nueva</button></div>
      <div className="grid cols-2"><div className="kpi"><div className="k">Por pagar</div><div className="v num neg">{money(total('owe'))}</div></div><div className="kpi"><div className="k">Por cobrar</div><div className="v num pos">{money(total('owed'))}</div></div></div>
      <div className="seg" role="tablist"><button role="tab" aria-selected={tab === 'owe'} onClick={() => setTab('owe')}>Yo debo</button><button role="tab" aria-selected={tab === 'owed'} onClick={() => setTab('owed')}>Me deben</button></div>
      {!shown.length ? <section className="card"><Empty icon="scale" title={tab === 'owe' ? 'No debes nada registrado' : 'Nadie te debe (según tus registros)'} text="Registra préstamos personales con su vencimiento y verás un plan de pagos orientativo." action={<button className="btn" onClick={() => setAdd(true)}>Registrar deuda</button>} /></section> :
        <div className="grid cols-2">{shown.map((d) => (
          <section className="card" key={d.id}>
            <div className="row between"><h3>{d.counterparty}</h3>{d.due_date && <span className={`badge ${new Date(d.due_date) < new Date() ? 'danger' : ''}`}>Vence {ymd(d.due_date)}</span>}</div>
            <div className="num" style={{ fontSize: '1.5rem', fontWeight: 700, margin: '6px 0' }}>{money(d.remaining, d.currency)} <span className="muted small" style={{ fontFamily: 'var(--font)' }}>de {money(d.original_amount, d.currency)}</span></div>
            <Progress pct={((d.original_amount - d.remaining) / d.original_amount) * 100} tone={undefined} />
            {d.direction === 'owe' && plan(d) && <p className="small muted">{plan(d)}</p>}
            {d.interest_rate != null && <p className="xs faint">Interés {d.interest_rate}% anual (informativo: registra los intereses pagados como gasto en la categoría Deudas).</p>}
            {d.notes && <p className="small">{d.notes}</p>}
            <button className="btn primary sm" onClick={() => setPay(d)}>{d.direction === 'owe' ? 'Pagar' : 'Cobrar'} / historial</button>
          </section>))}</div>}
      {debts!.some((d) => d.status === 'closed') && <p className="hint">Las deudas saldadas se ocultan; su historial sigue en Movimientos.</p>}
      {add && <DebtForm accounts={accounts ?? []} onClose={() => setAdd(false)} />}
      {pay && <Pay d={pay} accounts={accounts ?? []} onClose={() => setPay(null)} />}
    </div>
  );
}
