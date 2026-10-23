import { useEffect, useMemo, useRef, useState } from 'react';
import { NETWORKS, Pattern, TYPE_BADGE, designFor } from '../banks';
import { ACCOUNT_TYPES, money, ymd } from '../format';
import { Icon } from '../icons';
import { api } from '../api';
import { ErrorBlock, LoadingBlock, nav, useAction, useApi } from '../ui';
import { TxRow } from '../screens/Transactions';

function PatternLayer({ pattern, c }: { pattern: Pattern; c: string[] }) {
  // Formas geométricas propias (no son logotipos) para dar profundidad a cada diseño.
  switch (pattern) {
    case 'chevrons':
      return <g opacity=".55"><path d="M0 0h120l90 95-90 95H0z" fill={c[1]} /><path d="M70 0h70l95 95-95 95H70l95-95z" fill={c[2]} opacity=".7" /><path d="M200 110l60 80H150z" fill={c[1]} /></g>;
    case 'blocks':
      return <g><rect x="160" y="0" width="160" height="95" fill={c[1]} /><rect x="160" y="95" width="160" height="105" fill={c[2]} /><path d="M120 200V140a40 40 0 0 1 40-40h0v100z" fill={c[1]} opacity=".85" /></g>;
    case 'waves':
      return <g opacity=".6"><path d="M0 150C70 110 120 190 200 150s110-50 120-60v110H0z" fill={c[1]} /><path d="M0 175c80-30 140 20 210-5s90-40 110-45v75H0z" fill={c[2]} opacity=".75" /></g>;
    case 'diagonal':
      return <g opacity=".55"><path d="M180 0h140v200H60z" fill={c[1]} /><path d="M250 0h70v200h-150z" fill={c[2]} opacity=".55" /></g>;
    case 'circles':
      return <g opacity=".5"><circle cx="270" cy="30" r="95" fill={c[1]} /><circle cx="300" cy="180" r="70" fill={c[2]} opacity=".7" /><circle cx="40" cy="210" r="60" fill={c[1]} opacity=".6" /></g>;
    case 'bills':
      return <g opacity=".35" fill="none" stroke={c[2]} strokeWidth="2"><rect x="150" y="40" width="150" height="80" rx="8" /><rect x="170" y="70" width="150" height="80" rx="8" /><circle cx="245" cy="110" r="18" /></g>;
    default:
      return <path d="M0 140h320v60H0z" fill={c[2]} opacity=".25" />;
  }
}

/** Frente de tarjeta (proporción ISO 7810, 85.6 × 54 mm). */
export function CardFace({ a, showBalance = true, dim = false }: { a: any; showBalance?: boolean; dim?: boolean }) {
  const d = designFor(a);
  const net = NETWORKS[a.card_network ?? ''] ?? '';
  const isCard = a.type === 'debit_card' || a.type === 'credit_card';
  const amount = a.type === 'credit_card' ? (a.available_credit ?? -a.owed) : a.balance;
  const caption = a.type === 'credit_card' ? (a.available_credit != null ? 'Crédito disponible' : 'Saldo pendiente') : 'Saldo';
  return (
    <div className="cardface" style={{ background: `linear-gradient(135deg, ${d.colors[0]}, ${d.colors[0]} 55%, ${d.colors[1]})`, filter: dim ? 'brightness(.55) saturate(.8)' : undefined }} role="img" aria-label={`${a.name}, ${ACCOUNT_TYPES[a.type]}${a.last4 ? ` terminada en ${a.last4}` : ''}, ${caption} ${money(amount, a.currency)}`}>
      <svg className="cf-bg" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><PatternLayer pattern={d.pattern} c={d.colors} /></svg>
      <div className="cf-top">
        <span className="cf-badge">{TYPE_BADGE[a.type]}</span>
        <span className="cf-bank">{d.label}</span>
      </div>
      <div className="cf-mid">{isCard && <svg width="34" height="24" viewBox="0 0 34 24" aria-hidden="true"><rect x="1" y="1" width="26" height="22" rx="4" fill="#E9D59A" opacity=".9" /><path d="M1 8h9M1 16h9M18 8h9M18 16h9M10 1v22M18 1v22" stroke="#9C8546" strokeWidth=".9" /><path d="M29 7c2 3 2 7 0 10" stroke="#fff" strokeWidth="1.4" fill="none" opacity=".8" /><path d="M31.5 5c3 4 3 10 0 14" stroke="#fff" strokeWidth="1.4" fill="none" opacity=".6" /></svg>}</div>
      <div className="cf-bottom">
        <div>
          {showBalance && <><div className="cf-cap">{caption}</div><div className="cf-amt num">{money(amount, a.currency)}</div></>}
          <div className="cf-name">{a.name}{a.last4 ? ` ·· ${a.last4}` : ''}</div>
        </div>
        {net && <span className={`cf-net ${a.card_network}`}>{net}</span>}
      </div>
    </div>
  );
}

/** Pila de tarjetas estilo billetera: al tocarla se abre la billetera completa. */
export function WalletStack({ accounts }: { accounts: any[] }) {
  const [open, setOpen] = useState<null | { focus?: string }>(null);
  const list = accounts.filter((a) => !a.archived);
  if (!list.length) return null;
  const top = list[0];
  return (
    <>
      <button className="wallet-stack" onClick={() => setOpen({})} aria-label={`Abrir billetera: ${list.length} tarjeta(s)`}>
        {list.slice(1, 3).reverse().map((a, i, arr) => <div key={a.id} className="ws-behind" style={{ transform: `translateY(${-(arr.length - i) * 10}px) scale(${1 - (arr.length - i) * 0.04})` }}><CardFace a={a} showBalance={false} /></div>)}
        <div className="ws-front"><CardFace a={top} /></div>
      </button>
      {open && <WalletView accounts={list} focus={open.focus} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Billetera a pantalla completa: tarjetas superpuestas; al elegir una se ve su detalle y se puede deslizar entre ellas. */
export function WalletView({ accounts, focus, onClose }: { accounts: any[]; focus?: string; onClose: () => void }) {
  const [selected, setSelected] = useState<number | null>(focus ? Math.max(accounts.findIndex((a) => a.id === focus), 0) : null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') (selected != null ? setSelected(null) : onClose()); };
    document.addEventListener('keydown', k); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [selected, onClose]);
  return (
    <div className="wallet-view" role="dialog" aria-modal="true" aria-label="Billetera">
      <header className="wv-head">
        <button className="iconbtn" onClick={selected != null ? () => setSelected(null) : onClose} aria-label={selected != null ? 'Volver a todas las tarjetas' : 'Cerrar billetera'}><Icon name="close" /></button>
        <span className="muted small">{selected != null ? `${selected + 1} de ${accounts.length}` : `${accounts.length} tarjeta(s)`}</span>
        <button className="iconbtn" onClick={() => { onClose(); nav('/cuentas?nueva=1'); }} aria-label="Agregar tarjeta o cuenta"><Icon name="plus" /></button>
      </header>
      {selected == null ? (
        <div className="wv-deck">
          {accounts.map((a, i) => (
            <button key={a.id} className="wv-card" style={{ zIndex: i + 1, marginTop: i === 0 ? 0 : undefined }} onClick={() => setSelected(i)} aria-label={`Ver ${a.name}`}>
              <CardFace a={a} />
            </button>
          ))}
          <button className="btn ghost block" style={{ marginTop: 24 }} onClick={() => { onClose(); nav('/cuentas'); }}>Administrar cuentas y tarjetas</button>
        </div>
      ) : <CardCarousel accounts={accounts} index={selected} onIndex={setSelected} />}
    </div>
  );
}

function CardCarousel({ accounts, index, onIndex }: { accounts: any[]; index: number; onIndex: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.clientWidth;
    el.scrollTo({ left: index * w, behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [index]);
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index && i >= 0 && i < accounts.length) onIndex(i);
  };
  const a = accounts[index];
  return (
    <div className="wv-detail">
      <div className="wv-carousel" ref={ref} onScroll={onScroll} aria-label="Desliza para cambiar de tarjeta">
        {accounts.map((x, i) => <div key={x.id} className="wv-slide" aria-hidden={i !== index}><CardFace a={x} dim={i !== index} /></div>)}
      </div>
      <div className="wv-dots" role="tablist" aria-label="Tarjetas">{accounts.map((x, i) => <button key={x.id} role="tab" aria-selected={i === index} aria-label={x.name} className={i === index ? 'on' : ''} onClick={() => onIndex(i)} />)}</div>
      <CardDetails key={a.id} a={a} accounts={accounts} />
    </div>
  );
}

function CardDetails({ a, accounts }: { a: any; accounts: any[] }) {
  const { data: o, loading, error, reload } = useApi<any>(`/api/accounts/${a.id}/overview`);
  const [run, busy] = useAction();
  const isFirst = accounts[0]?.id === a.id;
  // Reordena la pila: esta tarjeta queda al frente y las demás conservan su orden relativo.
  const toFront = () => run(async () => {
    const order = [a, ...accounts.filter((x) => x.id !== a.id)];
    for (let i = 0; i < order.length; i++) if (order[i].sort_order !== i) await api.patch(`/api/accounts/${order[i].id}`, { sort_order: i });
  }, 'Tarjeta al frente de la pila');
  const credit = a.type === 'credit_card';
  const rows = useMemo(() => {
    if (!o) return [];
    const acc = o.account;
    return credit
      ? [['Crédito disponible', acc.available_credit], ['Saldo por pagar', acc.owed], ['Límite', acc.credit_limit], ['Gastado este mes', o.month_spent]]
      : [['Saldo', acc.balance], ...(acc.reserved_virtual ? [['Reservado en metas', acc.reserved_virtual]] : []), ['Gastado este mes', o.month_spent], ...(acc.bank_confirmed_balance != null ? [['Confirmado por el banco', acc.bank_confirmed_balance]] : [])];
  }, [o, credit]);
  if (error && !o) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !o) return <div style={{ padding: 16 }}><LoadingBlock rows={4} /></div>;
  return (
    <div className="wv-info fade-in">
      <div className="card">
        <h2 style={{ margin: '0 0 8px' }}>{a.name}{!isFirst && <button className="btn sm ghost link" disabled={busy} onClick={toFront}>Mostrar primero</button>}</h2>
        <div className="grid cols-2" style={{ gap: 10 }}>
          {rows.map(([k, v]) => <div key={k as string} className="kpi"><div className="k">{k}</div><div className="v num">{v == null ? '—' : money(v as number, a.currency)}</div></div>)}
        </div>
        {o.account.pending_count > 0 && <p className="small" style={{ marginBottom: 0 }}><span className="badge warn">{o.account.pending_count} por revisar</span> <span className="muted">no se incluyen en el saldo</span></p>}
      </div>
      <div className="card">
        <h2>Pagos agendados · {o.days} días <button className="btn sm ghost link" onClick={() => nav('/recurrentes')}>Gestionar</button></h2>
        {o.upcoming.length ? (
          <>
            <div className="list">{o.upcoming.map((u: any, i: number) => <div key={i} className="item" style={{ cursor: 'default' }}><span className="avatar mv"><Icon name="repeat" /></span><div className="grow"><div className="t">{u.name}</div><div className="s">{ymd(u.date)}{u.overdue ? ' · vencido' : ''}</div></div><div className="amt">{money(u.amount, a.currency)}</div></div>)}</div>
            <div className="hr" />
            <div className="row between small"><span className="muted">Total agendado</span><b className="num">{money(o.upcoming_total, a.currency)}</b></div>
            {o.after_upcoming != null && <div className="row between small"><span className="muted">{credit ? 'Crédito disponible después' : 'Te quedará después de pagarlos'}</span><b className={`num ${o.after_upcoming < 0 ? 'neg' : 'pos'}`}>{money(o.after_upcoming, a.currency)}</b></div>}
          </>
        ) : <p className="muted small" style={{ margin: 0 }}>No hay pagos recurrentes asignados a esta cuenta. Al crear una suscripción o factura, elige esta tarjeta en “Cuenta que se usará”.</p>}
      </div>
      <div className="card">
        <h2>Últimos movimientos {o.recent_total > o.recent.length && <span className="muted small" style={{ fontFamily: 'var(--font)', fontWeight: 400 }}>{o.recent_total} en total</span>}</h2>
        {o.recent.length ? <div className="list">{o.recent.map((t: any) => <TxRow key={t.id} t={t} />)}</div> : <p className="muted small" style={{ margin: 0 }}>Sin movimientos todavía.</p>}
      </div>
    </div>
  );
}

