import { api } from '../api';
import { money } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, LoadingBlock, nav, useAction, useApi } from '../ui';
import { openTx } from '../App';
import { TxRow } from './Transactions';

export function Review() {
  const { data, loading, error, reload } = useApi<any>('/api/transactions/review');
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const [run, busy] = useAction();
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={5} />;
  const items: any[] = data.items;
  // Una tarjeta de débito vinculada es el mismo dinero que su cuenta: se ofrecen ambas, como las ve la persona.
  const choices = (accounts ?? []).filter((a) => !a.archived);
  const ready = items.filter((t) => !t.duplicate_of && !t.account_pending);
  const asking = items.filter((t) => t.account_pending).length;
  return (
    <div className="stack">
      <div className="row between"><h1>Revisión</h1>{items.length > 0 && <button className="btn primary sm" disabled={busy || !ready.length} onClick={() => run(() => api.post('/api/transactions/review/confirm-all', { ids: ready.map((t) => t.id) }), 'Movimientos confirmados')}>Confirmar todos ({ready.length})</button>}</div>
      {asking > 0 && <div className="alert info" role="note"><Icon name="info" size={20} /><div className="small"><b>{asking} movimiento(s) necesitan tu ayuda:</b> no pude saber de qué tarjeta o cuenta son. Elígela en cada uno y luego confirma.</div></div>}
      <p className="muted small" style={{ margin: 0 }}>Los movimientos detectados (correo, notificación) o importados no afectan tus saldos ni informes hasta que los confirmes. Puedes corregir categoría, importe o cuenta antes de confirmar.</p>
      {!items.length ? <section className="card"><Empty icon="check" title="Todo al día" text="No hay movimientos pendientes de revisión." action={<button className="btn" onClick={() => nav('/integraciones')}>Vincular mi Gmail</button>} /></section> : (
        <section className="card"><div className="list">
          {items.map((t) => (
            <div key={t.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <TxRow t={t} />
              {t.review_hint && <p className="small warn" style={{ margin: '4px 0 6px 54px' }}>⚠️ {t.review_hint}</p>}
              {t.account_pending && (
                <div style={{ margin: '4px 0 8px 54px' }}>
                  <div className="small"><b>¿De qué tarjeta o cuenta es este {t.type === 'income' ? 'ingreso' : 'gasto'}?</b></div>
                  <div className="chips" role="group" aria-label="Tarjeta o cuenta del movimiento" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                    {choices.map((a) => <button key={a.id} type="button" className="chip" aria-pressed={false} disabled={busy} onClick={() => run(() => api.patch(`/api/transactions/${t.id}`, { account_id: a.id }), `Registrado en ${a.name}`)}>{a.name}{a.last4 ? ` ·· ${a.last4}` : ''}</button>)}
                  </div>
                </div>
              )}
              <div className="row wrap" style={{ gap: 6, paddingLeft: 54 }}>
                <button className="btn sm primary" disabled={busy || t.account_pending} title={t.account_pending ? 'Primero elige la tarjeta o cuenta' : undefined} onClick={() => run(() => api.post(`/api/transactions/${t.id}/confirm`), 'Confirmado')}><Icon name="check" size={14} />Confirmar</button>
                <button className="btn sm" onClick={() => openTx({ kind: t.type === 'income' ? 'income' : 'expense', tx: t })}>Corregir</button>
                <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.del(`/api/transactions/${t.id}`), 'Descartado')}>Descartar</button>
              </div>
            </div>))}
        </div></section>)}
    </div>
  );
}
