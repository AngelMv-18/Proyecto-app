import { useState } from 'react';
import { qs } from '../api';
import { dateShort, money, ymd } from '../format';
import { Icon } from '../icons';
import { ErrorBlock, Field, LoadingBlock, nav, useApi, useRoute } from '../ui';

const KINDS: [string, string][] = [['income_statement', 'Ingresos y gastos'], ['cash_flow', 'Flujo de caja'], ['category_summary', 'Por categoría'], ['balances', 'Evolución de saldos'], ['monthly_comparison', 'Comparación mensual'], ['net_worth', 'Patrimonio neto'], ['debts', 'Deudas'], ['recurring', 'Recurrentes'], ['savings_rate', 'Tasa de ahorro'], ['reconciliation', 'Registrado vs. conciliado']];
const Q_LABEL: Record<string, [string, string]> = { real: ['teal', 'Datos reales'], estimado: ['warn', 'Parcialmente estimado'], incompleto: ['danger', 'Datos incompletos'] };

function Digests() {
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week'); const [offset, setOffset] = useState(0);
  const { data: d, loading, error, reload } = useApi<any>(`/api/digests/${period}?offset=${offset}`);
  const label = { day: ['Hoy', 'Ayer'], week: ['Esta semana', 'Semana anterior'], month: ['Este mes', 'Mes anterior'] }[period];
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Período">{(['day', 'week', 'month'] as const).map((p) => <button key={p} role="tab" aria-selected={period === p} onClick={() => { setPeriod(p); setOffset(0); }}>{{ day: 'Diario', week: 'Semanal', month: 'Mensual' }[p]}</button>)}</div>
      <div className="row between"><button className="btn sm" onClick={() => setOffset(offset - 1)} aria-label="Período anterior">‹ Anterior</button><b>{offset === 0 ? label[0] : offset === -1 ? label[1] : `Hace ${-offset} períodos`}</b><button className="btn sm" disabled={offset === 0} onClick={() => setOffset(offset + 1)} aria-label="Período siguiente">Siguiente ›</button></div>
      {error && !d ? <ErrorBlock error={error} retry={reload} /> : loading && !d ? <LoadingBlock rows={5} /> : d && (
        <section className="card fade-in">
          <div className="row between wrap"><h2 style={{ margin: 0 }}>{d.title}</h2><span className={`badge ${d.quality === 'real' ? 'teal' : 'danger'}`}>{d.quality === 'real' ? 'Datos reales' : 'Datos incompletos'}</span></div>
          <p className="small muted">{dateShort(d.from)} → {dateShort(new Date(new Date(d.to).getTime() - 1000))}</p>
          <div className="kpis" style={{ margin: '10px 0' }}>
            <div className="kpi"><div className="k">Ingresos</div><div className="v num">{money(d.summary.income, undefined, { compact: true })}</div></div>
            <div className="kpi"><div className="k">Gastos</div><div className="v num">{money(d.summary.expense, undefined, { compact: true })}</div></div>
            <div className="kpi"><div className="k">Neto</div><div className={`v num ${d.summary.net < 0 ? 'neg' : ''}`}>{money(d.summary.net, undefined, { compact: true })}</div></div>
          </div>
          <ul className="small" style={{ paddingLeft: 18, display: 'grid', gap: 5 }}>{d.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
          {d.top_expenses.length > 0 && <><h3 style={{ margin: '12px 0 6px' }}>Gastos más grandes</h3>{d.top_expenses.map((t: any, i: number) => <div key={i} className="row between small" style={{ padding: '3px 0' }}><span>{t.merchant ?? t.category ?? 'Gasto'} · {dateShort(t.occurred_at)}</span><b className="num">{money(t.amount)}</b></div>)}</>}
          {d.categories.length > 0 && <><h3 style={{ margin: '12px 0 6px' }}>Por categoría</h3>{d.categories.map((c: any) => <div key={c.name} className="row between small" style={{ padding: '3px 0' }}><span>{c.name}</span><span className="num">{money(c.total)}</span></div>)}</>}
        </section>
      )}
      <p className="hint">Activa los resúmenes automáticos y las notificaciones en Perfil → Notificaciones y resúmenes.</p>
    </div>
  );
}

export function Reports() {
  const { query } = useRoute();
  if (query.get('vista') === 'resumenes') return <div className="stack"><h1>Informes</h1><div className="seg" role="tablist"><button role="tab" aria-selected={false} onClick={() => nav('/informes')}>Contables</button><button role="tab" aria-selected>Resúmenes</button></div><Digests /></div>;
  return <ReportsMain />;
}

function ReportsMain() {
  const [kind, setKind] = useState('income_statement');
  const first = new Date(); first.setDate(1);
  const [from, setFrom] = useState(first.toISOString().slice(0, 10)); const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const params = { from: from ? new Date(from + 'T00:00:00').toISOString() : undefined, to: to ? new Date(new Date(to + 'T00:00:00').getTime() + 86400000 - 1000).toISOString() : undefined };
  const { data: r, loading, error, reload } = useApi<any>(`/api/reports/${kind}${qs(params)}`);
  const cell = (c: any, v: any) => c.type === 'money' ? money(v) : c.type === 'pct' ? (v == null ? '—' : `${v}%`) : c.type === 'date' && v ? ymd(String(v).slice(0, 10)) : (v ?? '—');
  return (
    <div className="stack">
      <h1>Informes</h1>
      <div className="seg" role="tablist"><button role="tab" aria-selected>Contables</button><button role="tab" aria-selected={false} onClick={() => nav('/informes?vista=resumenes')}>Resúmenes</button></div>
      <div className="chips" role="tablist" aria-label="Tipo de informe">{KINDS.map(([k, l]) => <button key={k} role="tab" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
      <div className="grid cols-2" style={{ gap: 12 }}>
        <Field id="rf" label="Desde"><input id="rf" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="rt" label="Hasta"><input id="rt" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {error && !r ? <ErrorBlock error={error} retry={reload} /> : loading && !r ? <LoadingBlock rows={6} /> : r && (
        <section className="card fade-in">
          <div className="row between wrap"><h2 style={{ margin: 0 }}>{r.title}</h2><span className={`badge ${Q_LABEL[r.quality.level][0]}`}>{Q_LABEL[r.quality.level][1]}</span></div>
          <p className="small muted">Período {r.params.from} → {r.params.to} · {r.currency}</p>
          {r.quality.notes.length > 0 && <ul className="small" style={{ paddingLeft: 18, color: 'var(--muted)' }}>{r.quality.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
          {r.rows.length ? (
            <div className="scroll-x"><table className="tbl"><thead><tr>{r.columns.map((c: any) => <th key={c.key} className={c.type === 'money' || c.type === 'pct' ? 'r' : ''}>{c.label}</th>)}</tr></thead>
              <tbody>{r.rows.slice(0, 200).map((row: any, i: number) => <tr key={i}>{r.columns.map((c: any) => <td key={c.key} className={c.type === 'money' || c.type === 'pct' ? 'r' : ''}>{cell(c, row[c.key])}</td>)}</tr>)}</tbody></table></div>
          ) : <p className="muted">No hay datos para este período.</p>}
          {r.totals && Object.keys(r.totals).length > 0 && <div className="hr" />}
          {r.totals && Object.entries(r.totals).map(([k, v]) => <div key={k} className="row between" style={{ padding: '3px 0' }}><b>{k}</b><b className="num">{money(v as number)}</b></div>)}
          <div className="row wrap" style={{ marginTop: 16 }}>
            <a className="btn sm" href={`/api/reports/${kind}${qs({ ...params, format: 'csv' })}`}><Icon name="download" size={16} />CSV</a>
            <a className="btn sm" href={`/api/reports/${kind}${qs({ ...params, format: 'html' })}`} target="_blank" rel="noreferrer"><Icon name="receipt" size={16} />Versión imprimible / PDF</a>
          </div>
        </section>
      )}
    </div>
  );
}
