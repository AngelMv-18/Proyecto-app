import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api';
import { AreaChart, Bars, Donut } from '../charts';
import { openTx } from '../App';
import { SOURCE_LABEL, TYPE_LABEL, dateLong, dateShort, dateTime, dayKey, money, ymd } from '../format';
import { Icon, catIcon } from '../icons';
import { RefundForm } from '../components/TxForm';
import { Empty, ErrorBlock, Field, LoadingBlock, Sheet, confirmDialog, invalidate, nav, toast, toastError, useApi, useAction, useRoute } from '../ui';

export function TxRow({ t, onClick }: { t: any; onClick?: () => void }) {
  const [open, setOpen] = useState(false);
  const inflow = ['income', 'refund', 'debt_collection'].includes(t.type) || (t.type === 'adjustment' && t.amount > 0) || (t.type === 'goal_saving' && t.amount < 0);
  const move = t.type === 'transfer' || t.type === 'goal_saving';
  const sign = move ? '' : inflow ? '+' : '−';
  const title = t.merchant || t.description || TYPE_LABEL[t.type];
  const sub = [t.type === 'transfer' ? `${t.account_name} → ${t.to_account_name}` : t.category_name ?? TYPE_LABEL[t.type], t.account_name && t.type !== 'transfer' ? t.account_name : null, dateShort(t.occurred_at)].filter(Boolean).join(' · ');
  return (
    <>
      <button className="item" onClick={onClick ?? (() => setOpen(true))} aria-label={`${title}, ${TYPE_LABEL[t.type]}, ${money(Math.abs(t.amount), t.currency)}, ${dateShort(t.occurred_at)}${t.status !== 'confirmed' ? `, ${t.status === 'pending' ? 'pendiente de revisión' : 'anulado'}` : ''}`}>
        <span className={`avatar ${move ? 'mv' : inflow ? 'in' : 'out'}`}><Icon name={t.type === 'transfer' ? 'swap' : t.type === 'goal_saving' ? 'target' : t.type === 'debt_payment' || t.type === 'debt_collection' ? 'scale' : inflow ? 'arrowDown' : 'arrowUp'} /></span>
        <span className="grow" style={{ minWidth: 0 }}>
          <div className="t" style={t.status === 'void' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{title}</div>
          <div className="s">{sub}</div>
          <div className="row" style={{ gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
            {t.status === 'pending' && <span className="badge warn">Por revisar</span>}
            {t.status === 'void' && <span className="badge danger">Anulado</span>}
            {t.source !== 'manual' && <span className="badge violet">{SOURCE_LABEL[t.source]}</span>}
            {t.duplicate_of && t.status === 'pending' && <span className="badge danger">Posible duplicado</span>}
          </div>
        </span>
        <span className={`amt ${inflow && !move ? 'pos' : ''}`} style={t.status !== 'confirmed' ? { opacity: 0.6 } : undefined}>{sign}{money(Math.abs(t.amount), t.currency)}</span>
      </button>
      {open && <TxDetail id={t.id} onClose={() => setOpen(false)} />}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = { create: 'Creado', update: 'Editado', void: 'Anulado', confirm: 'Confirmado', discard: 'Descartado', duplicate_merged: 'Fuente adicional detectada', receipt_attached: 'Comprobante adjuntado' };

export function TxDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: t, loading, error, reload } = useApi<any>(`/api/transactions/${id}`);
  const [voiding, setVoiding] = useState(false); const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(false);
  const [run, busy] = useAction();
  if (loading && !t) return <Sheet title="Movimiento" onClose={onClose}><LoadingBlock /></Sheet>;
  if (error || !t) return <Sheet title="Movimiento" onClose={onClose}><ErrorBlock error={error ?? new Error('No encontrado')} retry={reload} /></Sheet>;
  const row = (k: string, v: any) => v ? <div className="row between small" style={{ padding: '5px 0' }}><span className="muted">{k}</span><span style={{ textAlign: 'right', maxWidth: '65%', overflowWrap: 'anywhere' }}>{v}</span></div> : null;
  return (
    <Sheet title={TYPE_LABEL[t.type]} onClose={onClose}>
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <div className="num" style={{ fontSize: '2.2rem', fontWeight: 700 }}>{money(Math.abs(t.amount), t.currency)}</div>
        <div className="row" style={{ justifyContent: 'center', gap: 6, marginTop: 4 }}>
          <span className={`badge ${t.status === 'confirmed' ? 'teal' : t.status === 'pending' ? 'warn' : 'danger'}`}>{t.status === 'confirmed' ? 'Confirmado' : t.status === 'pending' ? 'Pendiente de revisión' : 'Anulado'}</span>
          <span className="badge violet">{SOURCE_LABEL[t.source]}</span>
        </div>
      </div>
      {row('Fecha', dateTime(t.occurred_at))}{row('Comercio / destinatario', t.merchant)}{row('Descripción', t.description)}{row('Método de pago', t.payment_method)}
      {row('Etiquetas', t.tags?.join(', '))}{row('Origen del dato', t.source_label)}{row('Motivo de anulación', t.void_reason)}
      {t.duplicate_of && <div className="alert warning" style={{ margin: '10px 0' }}><Icon name="warn" size={18} /><span className="small">Se parece a otro movimiento ya registrado (mismo importe y fecha). Puede ser una compra repetida real; revísalo.</span></div>}
      {t.has_receipt && <div style={{ margin: '10px 0' }}><a className="btn sm" href={`/api/transactions/${t.id}/receipt`} target="_blank" rel="noreferrer"><Icon name="receipt" size={16} />Ver comprobante</a></div>}

      <div className="row wrap" style={{ margin: '14px 0' }}>
        {t.status === 'pending' && <button className="btn primary grow" disabled={busy} onClick={() => run(() => api.post(`/api/transactions/${t.id}/confirm`), 'Movimiento confirmado').then(onClose)}>Confirmar</button>}
        {t.status !== 'void' && <button className="btn grow" onClick={() => { onClose(); openTx({ kind: (['income', 'expense', 'transfer'].includes(t.type) ? t.type : 'expense') as any, tx: t }); }}><Icon name="edit" size={16} />Editar</button>}
        {t.status === 'confirmed' && t.type === 'expense' && <button className="btn grow" onClick={() => setRefund(true)}>Devolución</button>}
        {t.status === 'pending' && <button className="btn danger grow" onClick={async () => { if (await confirmDialog('Este movimiento detectado se descartará. Quedará en el historial de auditoría.', 'Descartar')) run(() => api.del(`/api/transactions/${t.id}`), 'Descartado').then(onClose); }}>Descartar</button>}
        {t.status === 'confirmed' && <button className="btn danger grow" onClick={() => setVoiding(true)}>Anular</button>}
      </div>
      {voiding && (
        <div className="card flat fade-in" style={{ marginBottom: 14 }}>
          <p className="small" style={{ marginTop: 0 }}>Anular no borra el movimiento: se conserva en el historial y deja de afectar saldos e indicadores.</p>
          <Field id="why" label="Motivo (obligatorio)"><input id="why" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: se registró dos veces" /></Field>
          <button className="btn danger block" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api.post(`/api/transactions/${t.id}/void`, { reason }), 'Movimiento anulado').then((r) => r && onClose())}>Confirmar anulación</button>
        </div>
      )}
      <h3 style={{ margin: '8px 0' }}>Historial de cambios</h3>
      <div className="stack" style={{ gap: 6 }}>{t.history.map((h: any) => <div key={h.id} className="row between small"><span>{ACTION_LABEL[h.action] ?? h.action}{h.detail ? ` — ${h.detail}` : ''}</span><span className="faint">{dateTime(h.created_at)}</span></div>)}</div>
      {refund && <RefundForm tx={t} onClose={() => { setRefund(false); onClose(); }} />}
    </Sheet>
  );
}

type F = { q: string; preset: string; from: string; to: string; account_id: string; category_id: string; payment_method: string; type: string; status: string };
const EMPTY: F = { q: '', preset: 'month', from: '', to: '', account_id: '', category_id: '', payment_method: '', type: '', status: '' };

function range(f: F): { from?: string; to?: string } {
  const now = new Date();
  const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (f.preset === 'today') return { from: sod(now).toISOString(), to: new Date(sod(now).getTime() + 86400000).toISOString() };
  if (f.preset === 'week') { const d = sod(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: d.toISOString(), to: new Date(d.getTime() + 7 * 86400000).toISOString() }; }
  if (f.preset === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString() };
  if (f.preset === 'range') return { from: f.from ? new Date(f.from + 'T00:00:00').toISOString() : undefined, to: f.to ? new Date(new Date(f.to + 'T00:00:00').getTime() + 86400000).toISOString() : undefined };
  return {};
}

function Filters({ f, set, accounts, cats, methods, hideType }: { f: F; set: (f: F) => void; accounts: any[]; cats: any[]; methods: string[]; hideType?: boolean }) {
  const [open, setOpen] = useState(false);
  const active = [f.account_id, f.category_id, f.payment_method, f.type, f.status].filter(Boolean).length;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <div className="grow" style={{ position: 'relative' }}><input className="input" type="search" placeholder="Buscar comercio o descripción…" aria-label="Buscar movimientos" value={f.q} onChange={(e) => set({ ...f, q: e.target.value })} /></div>
        <button className="iconbtn" aria-label={`Filtros${active ? ` (${active} activos)` : ''}`} onClick={() => setOpen(true)} style={active ? { borderColor: 'var(--lime)', color: 'var(--lime)' } : undefined}><Icon name="filter" /></button>
      </div>
      <div className="chips" role="group" aria-label="Período">
        {[['today', 'Hoy'], ['week', 'Semana'], ['month', 'Mes'], ['all', 'Todo'], ['range', 'Rango…']].map(([k, l]) => <button key={k} className="chip" aria-pressed={f.preset === k} onClick={() => { set({ ...f, preset: k }); if (k === 'range') setOpen(true); }}>{l}</button>)}
      </div>
      {open && (
        <Sheet title="Filtros" onClose={() => setOpen(false)}>
          {f.preset === 'range' && <div className="grid cols-2" style={{ gap: 0 }}><Field id="from" label="Desde"><input id="from" type="date" className="input" value={f.from} onChange={(e) => set({ ...f, from: e.target.value })} /></Field><Field id="to" label="Hasta"><input id="to" type="date" className="input" value={f.to} onChange={(e) => set({ ...f, to: e.target.value })} /></Field></div>}
          <Field id="facc" label="Cuenta"><select id="facc" className="input" value={f.account_id} onChange={(e) => set({ ...f, account_id: e.target.value })}><option value="">Todas</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field id="fcat" label="Categoría"><select id="fcat" className="input" value={f.category_id} onChange={(e) => set({ ...f, category_id: e.target.value })}><option value="">Todas</option>{cats.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field id="fpm" label="Método de pago"><select id="fpm" className="input" value={f.payment_method} onChange={(e) => set({ ...f, payment_method: e.target.value })}><option value="">Todos</option>{methods.map((m) => <option key={m}>{m}</option>)}</select></Field>
          {!hideType && <>
            <Field id="ftype" label="Tipo"><select id="ftype" className="input" value={f.type} onChange={(e) => set({ ...f, type: e.target.value })}><option value="">Todos</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field id="fst" label="Estado"><select id="fst" className="input" value={f.status} onChange={(e) => set({ ...f, status: e.target.value })}><option value="">Todos</option><option value="confirmed">Confirmados</option><option value="pending">Por revisar</option><option value="void">Anulados</option></select></Field>
          </>}
          <div className="row"><button className="btn grow" onClick={() => set({ ...EMPTY, q: f.q, preset: f.preset })}>Limpiar</button><button className="btn primary grow" onClick={() => setOpen(false)}>Aplicar</button></div>
        </Sheet>
      )}
    </div>
  );
}

function List({ f, accounts, cats, methods }: { f: F; accounts: any[]; cats: any[]; methods: string[] }) {
  const [limit, setLimit] = useState(40);
  const [debounced, setQ] = useState(f.q);
  useEffect(() => { const h = setTimeout(() => setQ(f.q), 250); return () => clearTimeout(h); }, [f.q]);
  useEffect(() => setLimit(40), [f.preset, f.from, f.to, f.account_id, f.category_id, f.payment_method, f.type, f.status, debounced]);
  const r = range(f);
  const { data, loading, error, reload } = useApi<any>(`/api/transactions${qs({ ...r, q: debounced, account_id: f.account_id, category_id: f.category_id, payment_method: f.payment_method, type: f.type, status: f.status, limit })}`);
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of data?.items ?? []) { const k = dayKey(t.occurred_at); (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
    return [...m.entries()];
  }, [data]);
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={6} />;
  const filtered = Boolean(f.q || f.account_id || f.category_id || f.payment_method || f.type || f.status || f.preset !== 'all');
  if (!data?.items.length) return <Empty icon="receipt" title={filtered ? 'Sin resultados' : 'Aún no hay movimientos'} text={filtered ? 'Prueba con otro período o limpia los filtros.' : 'Registra tu primer gasto o ingreso con el botón +.'} action={<button className="btn primary" onClick={() => openTx({ kind: 'expense' })}>Registrar un gasto</button>} />;
  return (
    <div>
      <div className="muted small">{data.total} movimiento(s)</div>
      {groups.map(([day, items]) => <section key={day}><div className="daylabel">{dateLong(items[0].occurred_at)}</div><div className="list">{items.map((t) => <TxRow key={t.id} t={t} />)}</div></section>)}
      {data.items.length < data.total && <button className="btn block" style={{ marginTop: 14 }} onClick={() => setLimit(limit + 40)}>Cargar más</button>}
      <div style={{ marginTop: 16 }}><a className="btn sm ghost" href={`/api/export/transactions.csv${qs({ ...r, q: debounced, account_id: f.account_id, category_id: f.category_id, status: f.status, type: f.type })}`}><Icon name="download" size={16} />Exportar CSV</a></div>
    </div>
  );
}

function Analysis({ f }: { f: F }) {
  const r = range(f);
  const { data: a, loading, error, reload } = useApi<any>(`/api/analysis${qs({ ...r, account_id: f.account_id, category_id: f.category_id, payment_method: f.payment_method })}`);
  if (error && !a) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !a) return <LoadingBlock rows={6} />;
  const s = a.summary;
  const mlabel = (m: string) => new Intl.DateTimeFormat('es', { month: 'short', timeZone: 'UTC' }).format(new Date(m + '-15T00:00:00Z'));
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><div className="k">Ingresos</div><div className="v num">{money(s.income, undefined, { compact: true })}</div></div>
        <div className="kpi"><div className="k">Gastos</div><div className="v num">{money(s.expense, undefined, { compact: true })}</div></div>
        <div className="kpi"><div className="k">Neto</div><div className={`v num ${s.net < 0 ? 'neg' : ''}`}>{money(s.net, undefined, { compact: true })}</div></div>
      </div>
      <p className="hint">Las transferencias entre tus cuentas, los pagos de deuda y los aportes a metas no cuentan como ingresos ni gastos.</p>
      <div className="grid cols-2">
        <section className="card"><h2>Gastos por categoría</h2>{a.categories.length ? <Donut data={a.categories.map((c: any) => ({ name: c.name, value: c.total }))} /> : <p className="muted small">Sin gastos en este filtro.</p>}</section>
        <section className="card"><h2>Evolución diaria del saldo</h2><AreaChart showAxis label="Saldo diario" data={a.balance.map((b: any) => ({ x: ymd(b.day), y: b.balance }))} height={150} /></section>
        <section className="card"><h2>Gasto diario</h2><AreaChart color="var(--danger)" label="Gasto diario" data={a.daily.map((d: any) => ({ x: ymd(d.day), y: d.expense }))} height={150} /></section>
        <section className="card"><h2>Tendencia semanal de consumo</h2><Bars label="Gasto por semana, últimas 8 semanas" height={140} data={a.weekly.map((w: any) => ({ label: dateShort(w.week + 'T12:00:00Z'), values: [w.expense] }))} series={[{ name: 'Gasto semanal', color: '#8B7BFF' }]} /></section>
        <section className="card"><h2>Comparación entre meses</h2><Bars label="Ingresos y gastos por mes" data={a.monthly.map((m: any) => ({ label: mlabel(m.month), values: [m.income, m.expense] }))} series={[{ name: 'Ingresos', color: '#2DE2D0' }, { name: 'Gastos', color: '#FF6B7A' }]} /></section>
        <section className="card"><h2>Evolución del ahorro</h2><AreaChart color="var(--teal)" label="Ahorro neto mensual" showAxis data={a.monthly.map((m: any) => ({ x: mlabel(m.month), y: m.net }))} height={150} /></section>
      </div>
    </div>
  );
}

export function Transactions() {
  const { query } = useRoute();
  const view = query.get('vista') === 'analisis' ? 'analisis' : 'lista';
  const [f, setF] = useState<F>(EMPTY);
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const { data: cats } = useApi<any[]>('/api/categories');
  const { data: an } = useApi<any>('/api/analysis');
  return (
    <div className="stack">
      <h1>Movimientos</h1>
      <div className="seg" role="tablist" aria-label="Vista">
        <button role="tab" aria-selected={view === 'lista'} onClick={() => nav('/movimientos')}>Lista</button>
        <button role="tab" aria-selected={view === 'analisis'} onClick={() => nav('/movimientos?vista=analisis')}>Análisis</button>
      </div>
      <Filters f={f} set={setF} accounts={accounts ?? []} cats={cats ?? []} methods={an?.payment_methods ?? []} hideType={view === 'analisis'} />
      {view === 'lista' ? <List f={f} accounts={accounts ?? []} cats={cats ?? []} methods={an?.payment_methods ?? []} /> : <Analysis f={f} />}
    </div>
  );
}
