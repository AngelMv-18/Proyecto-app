import { useEffect, useState } from 'react';
import { api } from '../api';
import { Ring } from '../charts';
import { fromMinor, money, toMinor, ymd } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, Sheet, confirmDialog, nav, useAction, useApi, useRoute } from '../ui';

function GoalForm({ g, accounts, onClose }: { g?: any; accounts: any[]; onClose: () => void }) {
  const [name, setName] = useState(g?.name ?? ''); const [target, setTarget] = useState(g ? fromMinor(g.target_amount) : ''); const [date, setDate] = useState(g?.target_date ?? '');
  const [prio, setPrio] = useState(String(g?.priority ?? 2)); const [acc, setAcc] = useState(g?.account_id ?? ''); const [contrib, setContrib] = useState(g?.contribution_amount ? fromMinor(g.contribution_amount) : ''); const [freq, setFreq] = useState(g?.contribution_frequency ?? 'monthly');
  const [errs, setErrs] = useState<Record<string, string>>({}); const [run, busy] = useAction();
  const save = async () => {
    const t = toMinor(target); const fe: Record<string, string> = {};
    if (!name.trim()) fe.name = 'Ponle un nombre'; if (!t || t <= 0) fe.target = 'Indica el importe objetivo';
    setErrs(fe); if (Object.keys(fe).length) return;
    const body = { name: name.trim(), target_amount: t, target_date: date || null, priority: Number(prio), account_id: acc || null, contribution_amount: contrib ? toMinor(contrib) : null, contribution_frequency: contrib ? freq : null };
    const r = await run(() => g ? api.patch(`/api/goals/${g.id}`, body) : api.post('/api/goals', body), g ? 'Meta actualizada' : 'Meta creada'); if (r) onClose();
  };
  return (
    <Sheet title={g ? 'Editar meta' : 'Nueva meta'} onClose={onClose}>
      <Field id="gn" label="Nombre" error={errs.name}><input id="gn" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Teléfono nuevo" /></Field>
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="gt" label="Importe objetivo" error={errs.target}><input id="gt" className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <Field id="gd" label="Fecha objetivo"><input id="gd" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field id="gp" label="Prioridad"><select id="gp" className="input" value={prio} onChange={(e) => setPrio(e.target.value)}><option value="1">Alta</option><option value="2">Media</option><option value="3">Baja</option></select></Field>
      <Field id="ga" label="¿Dónde está el dinero?" hint={g ? 'No se puede cambiar después de registrar aportes.' : 'Reserva virtual: el dinero sigue en su cuenta pero queda apartado. Cuenta real: un aporte lo mueve a esa cuenta.'}>
        <select id="ga" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">Reserva virtual (sin mover dinero)</option>{accounts.filter((a) => !a.archived && a.type !== 'credit_card').map((a) => <option key={a.id} value={a.id}>Cuenta real: {a.name}</option>)}</select>
      </Field>
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="gc" label="Aportación periódica (opcional)"><input id="gc" className="input" inputMode="decimal" value={contrib} onChange={(e) => setContrib(e.target.value)} /></Field>
        <Field id="gf" label="Frecuencia"><select id="gf" className="input" value={freq} onChange={(e) => setFreq(e.target.value)}><option value="weekly">Semanal</option><option value="monthly">Mensual</option></select></Field>
      </div>
      <button className="btn primary block" disabled={busy} onClick={save}>Guardar</button>
    </Sheet>
  );
}

function Contribute({ g, accounts, onClose }: { g: any; accounts: any[]; onClose: () => void }) {
  const list = accounts.filter((a) => !a.archived && a.type !== 'credit_card' && a.id !== g.account_id);
  const [acc, setAcc] = useState(list[0]?.id ?? ''); const [amount, setAmount] = useState(g.weekly_needed ? fromMinor(g.weekly_needed) : ''); const [out, setOut] = useState(false); const [run, busy] = useAction();
  return (
    <Sheet title={`${out ? 'Retirar de' : 'Aportar a'} ${g.name}`} onClose={onClose}>
      <div className="seg" style={{ marginBottom: 14 }}><button aria-pressed={!out} onClick={() => setOut(false)}>Aportar</button><button aria-pressed={out} onClick={() => setOut(true)}>Retirar</button></div>
      <Field id="ca" label={out ? 'Cuenta que recibe' : 'Cuenta de origen'}><select id="ca" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>{list.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}</select></Field>
      <Field id="cm" label="Importe"><input id="cm" className="input amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <p className="hint">{g.virtual ? 'Reserva virtual: el saldo de la cuenta no cambia, pero ese dinero deja de contarse como libre. No se registra como ingreso.' : `El dinero se mueve a ${g.account_name}. Es una transferencia, no un gasto.`}</p>
      <button className="btn primary block" disabled={busy || !acc} onClick={() => { const m = toMinor(amount); if (!m || m <= 0) return; run(() => api.post(`/api/goals/${g.id}/contribute`, { account_id: acc, amount: out ? -m : m }), out ? 'Retiro registrado' : 'Aporte registrado').then((r) => r && onClose()); }}>{out ? 'Retirar' : 'Aportar'}</button>
    </Sheet>
  );
}

export function Goals() {
  const { data: goals, loading, error, reload } = useApi<any[]>('/api/goals');
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const { query } = useRoute();
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [con, setCon] = useState<any>(null); const [run] = useAction();
  useEffect(() => { if (query.get('nueva')) setEdit('new'); }, []); // eslint-disable-line
  if (error && !goals) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !goals) return <LoadingBlock rows={4} />;
  const active = goals!.filter((g) => g.status === 'active'), rest = goals!.filter((g) => g.status !== 'active');
  const tip = (g: any) => {
    if (g.missing === 0) return '¡Meta cumplida! Puedes marcarla como terminada.';
    if (g.behind) return g.monthly_needed ? `Va retrasada: para llegar a tiempo necesitas ≈ ${money(g.monthly_needed)} al mes (${money(g.weekly_needed)} por semana).` : 'La fecha objetivo ya pasó. Ajusta la fecha o el importe.';
    if (g.monthly_needed) return `Para llegar el ${ymd(g.target_date)} necesitas ≈ ${money(g.weekly_needed)} por semana (${money(g.monthly_needed)} al mes).`;
    if (g.eta_date && g.eta_date !== 'cumplida') return `Al ritmo actual la alcanzarías hacia el ${ymd(g.eta_date)}. Ponle una fecha objetivo para calcular cuánto ahorrar.`;
    return 'Define una fecha objetivo para calcular cuánto ahorrar por semana o mes.';
  };
  return (
    <div className="stack">
      <div className="row between"><h1>Metas de ahorro</h1><button className="btn primary sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Nueva</button></div>
      {!active.length && <section className="card"><Empty icon="target" title="Crea tu primera meta" text="Un teléfono, un fondo de emergencia, estudios, un viaje… Verás cuánto ahorrar por semana para lograrlo." action={<button className="btn primary" onClick={() => setEdit('new')}>Crear meta</button>} /></section>}
      <div className="grid cols-2">{active.map((g) => (
        <section key={g.id} className="card">
          <div className="row"><Ring pct={g.pct} size={76} /><div className="grow"><h3>{g.name}</h3><div className="num small">{money(g.saved)} <span className="muted">de {money(g.target_amount)}</span></div>
            <div className="row wrap" style={{ gap: 4, marginTop: 4 }}><span className={`badge ${g.virtual ? 'violet' : 'teal'}`}>{g.virtual ? 'Reserva virtual' : `Cuenta real: ${g.account_name}`}</span><span className="badge">Prioridad {['', 'alta', 'media', 'baja'][g.priority]}</span>{g.behind && <span className="badge warn">Retrasada</span>}</div></div></div>
          <p className="small muted" style={{ margin: '12px 0 6px' }}>{tip(g)}</p>
          {g.eta_date && g.eta_date !== 'cumplida' && <p className="xs faint" style={{ margin: 0 }}>Estimación por tu ritmo real: {ymd(g.eta_date)}.</p>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary sm" onClick={() => setCon(g)}>Aportar / retirar</button>
            <button className="btn sm" onClick={() => nav('/ia')}><Icon name="spark" size={14} />Preguntar a NOVA</button>
            <button className="btn sm ghost" onClick={() => setEdit(g)}>Editar</button>
            <button className="btn sm ghost" onClick={async () => { if (await confirmDialog(`¿Marcar "${g.name}" como ${g.missing === 0 ? 'cumplida' : 'archivada'}? El dinero reservado volverá a contarse como libre.`, 'Confirmar')) run(() => api.patch(`/api/goals/${g.id}`, { status: g.missing === 0 ? 'done' : 'archived' }), 'Meta actualizada'); }}>{g.missing === 0 ? 'Terminar' : 'Archivar'}</button>
          </div>
        </section>))}</div>
      {rest.length > 0 && <><h3 className="muted">Terminadas o archivadas</h3><div className="grid cols-2">{rest.map((g) => <div key={g.id} className="card flat row between"><span>{g.name}</span><span className="muted small num">{money(g.saved)}</span></div>)}</div></>}
      {edit && <GoalForm g={edit === 'new' ? undefined : edit} accounts={accounts ?? []} onClose={() => setEdit(null)} />}
      {con && <Contribute g={con} accounts={accounts ?? []} onClose={() => setCon(null)} />}
    </div>
  );
}
