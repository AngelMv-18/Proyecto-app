import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, money } from '../format';
import { Icon } from '../icons';
import { Empty, LoadingBlock, Sheet, invalidate, nav, toastError, useApi } from '../ui';
import { TxDetail } from './Transactions';

export function Notifications({ onClose }: { onClose: () => void }) {
  const { data, loading } = useApi<any[]>('/api/notifications');
  return (
    <Sheet title="Notificaciones" onClose={onClose}>
      {loading && !data ? <LoadingBlock /> : !data?.length ? <Empty icon="bell" title="Sin notificaciones" text="Te avisaremos de presupuestos, pagos próximos y movimientos por revisar, sin saturarte." /> : (
        <>
          <button className="btn sm ghost" style={{ marginBottom: 8 }} onClick={() => api.post('/api/notifications/read-all').then(invalidate).catch(toastError)}>Marcar todas como leídas</button>
          <div className="stack" style={{ gap: 8 }}>{data.map((n) => (
            <div key={n.id} className={`alert ${n.severity}`} style={{ opacity: n.read_at ? 0.6 : 1 }}><Icon name={n.severity === 'info' ? 'info' : 'warn'} size={20} />
              <div className="grow"><b className="small">{n.title}</b><div className="small muted">{n.body}</div><div className="xs faint">{dateTime(n.created_at)}</div></div>
              {!n.read_at && <button className="iconbtn" style={{ width: 36, height: 36 }} aria-label="Marcar como leída" onClick={() => api.post(`/api/notifications/${n.id}/read`).then(invalidate).catch(toastError)}><Icon name="check" size={16} /></button>}</div>))}</div>
        </>)}
    </Sheet>
  );
}

export function SearchSheet({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any>(null); const [tx, setTx] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const h = setTimeout(() => api.get('/api/search?q=' + encodeURIComponent(q.trim())).then(setRes).catch(toastError), 250);
    return () => clearTimeout(h);
  }, [q]);
  const go = (to: string) => { onClose(); nav(to); };
  const empty = res && Object.values(res).every((v: any) => !v.length);
  return (
    <>
      <Sheet title="Búsqueda global" onClose={onClose}>
        <input className="input" type="search" autoFocus aria-label="Buscar" placeholder="Movimientos, cuentas, metas, deudas…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="stack" style={{ marginTop: 14 }}>
          {empty && <p className="muted">Sin resultados para “{q}”.</p>}
          {res?.transactions.length > 0 && <div><div className="daylabel">Movimientos</div>{res.transactions.map((t: any) => <button key={t.id} className="item" onClick={() => setTx(t.id)}><div className="grow"><div className="t">{t.merchant ?? t.description ?? 'Movimiento'}</div><div className="s">{dateTime(t.occurred_at)}</div></div><div className="amt">{money(t.amount, t.currency)}</div></button>)}</div>}
          {([['accounts', 'Cuentas', '/cuentas'], ['goals', 'Metas', '/metas'], ['debts', 'Deudas', '/deudas'], ['recurring', 'Recurrentes', '/recurrentes'], ['categories', 'Categorías', '/presupuestos']] as const).map(([k, l, to]) => res?.[k]?.length > 0 && <div key={k}><div className="daylabel">{l}</div>{res[k].map((x: any) => <button key={x.id} className="item" onClick={() => go(to)}><div className="t">{x.name}</div></button>)}</div>)}
        </div>
      </Sheet>
      {tx && <TxDetail id={tx} onClose={() => setTx(null)} />}
    </>
  );
}
