import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AreaChart, Bars, Donut, Gauge, Ring } from '../charts';
import { openTx } from '../App';
import { ACCOUNT_TYPES, dateShort, money, ymd } from '../format';
import { Icon, catIcon } from '../icons';
import { Empty, ErrorBlock, LoadingBlock, Progress, Sheet, invalidate, nav, toastError, useApi } from '../ui';
import { TxRow } from './Transactions';
import { WalletStack } from '../components/Wallet';

function CountUp({ value }: { value: number }) {
  const [v, setV] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(value); return; }
    const from = prev.current, t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => { const p = Math.min((t - t0) / 700, 1); setV(Math.round(from + (value - from) * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); else prev.current = value; };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{money(v).replace(/^[A-Z]{3}\s?/, '')}</>;
}

const delta = (cur: number, prev: number, goodUp: boolean) => {
  if (!prev) return null;
  const p = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const good = goodUp ? p >= 0 : p <= 0;
  return <span className={`d ${good ? 'pos' : 'neg'}`}>{p >= 0 ? '▲' : '▼'} {Math.abs(p)}% vs mes ant.</span>;
};

export function Home({ me }: { me: any }) {
  const { data: d, error, loading, reload } = useApi<any>('/api/dashboard');
  const [health, setHealth] = useState(false);
  if (loading && !d) return <div className="stack"><LoadingBlock rows={4} /><LoadingBlock rows={3} /></div>;
  if (error && !d) return <ErrorBlock error={error} retry={reload} />;
  if (!d) return null;
  const hasAccounts = d.accounts.length > 0;
  const hour = new Date().getHours();
  const hi = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const bal = d.balance_series.map((s: any) => ({ x: ymd(s.day), y: s.balance }));
  const cats = d.categories.map((c: any) => ({ name: c.name, value: c.total })).filter((c: any) => c.value > 0);
  const monthLbl = (m: string) => new Intl.DateTimeFormat(me.locale, { month: 'short', timeZone: 'UTC' }).format(new Date(m + '-15T00:00:00Z'));

  return (
    <div className="stack">
      <div className="muted">{hi}, <b style={{ color: 'var(--text)' }}>{me.display_name}</b></div>

      {!hasAccounts && (
        <section className="card glow"><Empty icon="wallet" title="Empecemos por tus cuentas" text="Crea tu efectivo, tu cuenta bancaria o tarjeta con su saldo actual. Con eso ya puedes registrar gastos desde hoy; no necesitas conectar ningún banco." action={<button className="btn primary" onClick={() => nav('/cuentas?nueva=1')}>Crear mi primera cuenta</button>} /></section>
      )}

      <div className="grid dash">
        <div className="stack">
          <section className="card glow hero fade-in" aria-label="Saldo principal">
            <div className="label">SALDO DISPONIBLE · efectivo, bancos y billeteras</div>
            <div className="big num"><small>{d.currency}</small><CountUp value={d.available} /></div>
            <div className="row wrap small muted" style={{ gap: '4px 14px' }}>
              <span>Reservado en metas: <b className="num">{money(d.reserved)}</b></span>
              <span>Comprometido 30 d: <b className="num">{money(d.committed)}</b></span>
            </div>
            <div className="small" style={{ marginTop: 6 }}>Libre para gastar: <b className={`num ${d.free_to_spend < 0 ? 'neg' : 'pos'}`}>{money(d.free_to_spend)}</b></div>
            <div className="chart"><AreaChart data={bal} height={96} label="Evolución del saldo en los últimos 30 días" /></div>
          </section>

          <div className="kpis">
            <div className="kpi"><div className="k"><i className="dotc" style={{ background: 'var(--ok)' }} />Ingresos</div><div className="v num">{money(d.month.income, undefined, { compact: true })}</div>{delta(d.month.income, d.prev_month.income, true)}</div>
            <div className="kpi"><div className="k"><i className="dotc" style={{ background: 'var(--danger)' }} />Gastos</div><div className="v num">{money(d.month.expense, undefined, { compact: true })}</div>{delta(d.month.expense, d.prev_month.expense, false)}</div>
            <div className="kpi"><div className="k"><i className="dotc" style={{ background: 'var(--teal)' }} />Ahorro neto</div><div className={`v num ${d.month.net < 0 ? 'neg' : ''}`}>{money(d.month.net, undefined, { compact: true })}</div>{delta(d.month.net, d.prev_month.net, true)}</div>
          </div>

          <div className="row" role="group" aria-label="Acceso rápido" style={{ gap: 8 }}>
            <button className="btn grow" onClick={() => openTx({ kind: 'expense' })}><Icon name="arrowUp" size={18} />Gasto</button>
            <button className="btn grow" onClick={() => openTx({ kind: 'income' })}><Icon name="arrowDown" size={18} />Ingreso</button>
            <button className="btn grow" onClick={() => openTx({ kind: 'transfer' })}><Icon name="swap" size={18} />Mover</button>
            <button className="btn primary grow" onClick={() => nav('/ia')}><Icon name="spark" size={18} />NOVA</button>
          </div>

          {d.accounts.length > 0 && (
            <section aria-label="Mis tarjetas">
              <div className="row between"><h2>Mis tarjetas</h2><button className="btn sm ghost" onClick={() => nav('/cuentas?nueva=1')}><Icon name="plus" size={16} />Agregar</button></div>
              <WalletStack accounts={d.accounts} />
              <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>Toca para desplegar tus tarjetas y ver sus fondos y pagos agendados</p>
            </section>
          )}

          {d.review_count > 0 && (
            <button className="alert info" style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }} onClick={() => nav('/revision')}>
              <Icon name="mail" /><div className="grow"><b>{d.review_count} movimiento(s) por revisar</b><div className="small muted">Detectados o importados: no afectan tus saldos hasta que los confirmes.</div></div><Icon name="chevron" />
            </button>
          )}

          <section className="card" aria-label="Gastos por categoría">
            <h2>Gastos por categoría <span className="muted small" style={{ fontFamily: 'var(--font)', fontWeight: 400 }}>este mes</span></h2>
            {cats.length ? <Donut data={cats} /> : <Empty icon="pie" title="Sin gastos este mes" text="Cuando registres gastos verás aquí en qué se va tu dinero." />}
          </section>

          <section className="card" aria-label="Ingresos frente a gastos">
            <h2>Ingresos vs gastos <button className="btn sm ghost link" onClick={() => nav('/movimientos?vista=analisis')}>Ver análisis</button></h2>
            <Bars label="Ingresos frente a gastos de los últimos seis meses" data={d.monthly.map((m: any) => ({ label: monthLbl(m.month), values: [m.income, m.expense] }))} series={[{ name: 'Ingresos', color: '#2DE2D0' }, { name: 'Gastos', color: '#FF6B7A' }]} />
          </section>

          <section className="card" aria-label="Actividad reciente">
            <h2>Actividad reciente <button className="btn sm ghost link" onClick={() => nav('/movimientos')}>Ver todo</button></h2>
            {d.recent.length ? <div className="list">{d.recent.map((t: any) => <TxRow key={t.id} t={t} />)}</div> : <Empty icon="receipt" title="Aún no hay movimientos" text="Registra tu primer gasto en menos de 10 segundos con el botón +." action={<button className="btn primary" onClick={() => openTx({ kind: 'expense' })}>Registrar un gasto</button>} />}
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-label="Salud financiera">
            <h2>Salud financiera</h2>
            <div className="row" style={{ alignItems: 'center' }}>
              <Gauge score={d.health.score} label={d.health.label} />
              <div className="grow small muted">{d.health.note}<div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => setHealth(true)}>¿Cómo se calcula?</button></div></div>
            </div>
          </section>

          {d.alerts.length > 0 && (
            <section className="card" aria-label="Alertas inteligentes">
              <h2>Alertas inteligentes</h2>
              <div className="stack" style={{ gap: 8 }}>
                {d.alerts.map((a: any) => (
                  <div key={a.id} className={`alert ${a.severity}`}><Icon name={a.severity === 'info' ? 'info' : 'warn'} size={20} /><div className="grow"><b className="small">{a.title}</b><div className="small muted">{a.body}</div></div><button className="iconbtn" style={{ width: 36, height: 36 }} aria-label="Marcar como leída" onClick={() => api.post(`/api/notifications/${a.id}/read`).then(invalidate).catch(toastError)}><Icon name="check" size={16} /></button></div>
                ))}
              </div>
            </section>
          )}

          <section className="card" aria-label="Presupuestos">
            <h2>Presupuesto del mes <button className="btn sm ghost link" onClick={() => nav('/presupuestos')}>Gestionar</button></h2>
            {d.budget.total ? (<>
              <div className="row between small"><span>{money(d.budget.spent)} de {money(d.budget.total)}</span><b className="num">{d.budget.pct}%</b></div>
              <Progress pct={d.budget.pct} />
              <div className="stack" style={{ gap: 10, marginTop: 14 }}>{d.budgets.filter((b: any) => b.period === 'monthly').sort((a: any, b: any) => b.pct - a.pct).slice(0, 3).map((b: any) => <div key={b.id}><div className="row between small"><span>{b.category_name}</span><span className="muted num">{Math.round(b.pct)}%</span></div><Progress pct={b.pct} /></div>)}</div>
            </>) : <Empty icon="pie" title="Sin presupuestos" text="Define límites por categoría y recibe avisos al 50, 75, 90 y 100 %." action={<button className="btn" onClick={() => nav('/presupuestos')}>Crear presupuesto</button>} />}
          </section>

          <section className="card" aria-label="Metas de ahorro">
            <h2>Metas de ahorro <button className="btn sm ghost link" onClick={() => nav('/metas')}>Ver</button></h2>
            {d.goals.length ? <div className="stack">{d.goals.slice(0, 3).map((g: any) => (
              <div className="row" key={g.id}><Ring pct={g.pct} /><div className="grow"><div style={{ fontWeight: 600 }}>{g.name}</div><div className="small muted num">{money(g.saved)} / {money(g.target_amount)}</div>{g.behind && <span className="badge warn">Va retrasada</span>}{g.monthly_needed && !g.behind ? <div className="xs faint">Necesitas ≈ {money(g.monthly_needed)}/mes</div> : null}</div></div>
            ))}</div> : <Empty icon="target" title="Sin metas aún" text="Un teléfono, un fondo de emergencia, un viaje…" action={<button className="btn" onClick={() => nav('/metas?nueva=1')}>Crear una meta</button>} />}
          </section>

          <section className="card" aria-label="Cuentas">
            <h2>Mis cuentas <button className="btn sm ghost link" onClick={() => nav('/cuentas')}>Gestionar</button></h2>

            <div className="list">{d.accounts.map((a: any) => (
              <div className="item" key={a.id} style={{ cursor: 'default' }}><span className="avatar"><Icon name={a.type === 'cash' ? 'coin' : a.type === 'credit_card' || a.type === 'debit_card' ? 'card' : 'wallet'} /></span>
                <div className="grow"><div className="t">{a.name}</div><div className="s">{ACCOUNT_TYPES[a.type]}{a.type === 'credit_card' && a.available_credit != null ? ` · crédito disponible ${money(a.available_credit, a.currency)}` : ''}</div></div>
                <div style={{ textAlign: 'right' }}><div className={`amt ${a.balance < 0 ? 'neg' : ''}`}>{money(a.balance, a.currency)}</div>{a.currency !== d.currency && <div className="xs faint">{a.balance_base != null ? `≈ ${money(a.balance_base)}` : 'sin tipo de cambio'}</div>}</div></div>
            ))}</div>
            <div className="hr" />
            <div className="row between small"><span className="muted">Patrimonio neto estimado</span><b className="num">{money(d.net_worth)}</b></div>
            <div className="row between small"><span className="muted">Por cobrar / por pagar</span><span className="num">{money(d.receivable)} / {money(d.payable)}</span></div>
            {d.foreign_accounts > 0 && <p className="hint">{d.foreign_accounts} cuenta(s) en otra moneda sin tipo de cambio no se suman aquí (Perfil → Tipos de cambio).</p>}
            {d.converted_accounts > 0 && <p className="hint">Incluye {d.converted_accounts} cuenta(s) en otra moneda convertidas con tu tipo de cambio manual (estimación).</p>}
          </section>

          <section className="card" aria-label="Próximos compromisos">
            <h2>Próximos compromisos <button className="btn sm ghost link" onClick={() => nav('/recurrentes')}>Ver</button></h2>
            {d.obligations.length ? <div className="list">{d.obligations.map((o: any, i: number) => <div className="item" key={i} style={{ cursor: 'default' }}><span className="avatar mv"><Icon name={o.kind === 'debt' ? 'scale' : 'repeat'} /></span><div className="grow"><div className="t">{o.name}</div><div className="s">{ymd(o.date)}{o.overdue ? ' · vencido' : ''}</div></div><div className="amt">{money(o.amount)}</div></div>)}</div> : <p className="muted small">No tienes pagos recurrentes ni deudas por vencer registrados.</p>}
          </section>
        </div>
      </div>
      {health && (
        <Sheet title="Cómo se calcula tu salud financiera" onClose={() => setHealth(false)}>
          <p className="muted small" style={{ marginTop: 0 }}>{d.health.note} Es una estimación orientativa con tus datos registrados, no una calificación crediticia.</p>
          <div className="stack">{d.health.parts.map((p: any) => (
            <div key={p.key}><div className="row between"><b>{p.label}</b><span className="muted small">{p.score == null ? 'sin datos' : `${p.score}/100`} · peso {p.weight}%</span></div>{p.score != null && <Progress pct={p.score} tone={p.score < 30 ? 'danger' : p.score < 55 ? 'warn' : undefined} />}<div className="small muted">{p.detail}</div></div>
          ))}</div>
        </Sheet>
      )}
    </div>
  );
}
