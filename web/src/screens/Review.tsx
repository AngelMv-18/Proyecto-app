import { api } from '../api';
import { money } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, LoadingBlock, nav, useAction, useApi } from '../ui';
import { openTx } from '../App';
import { TxRow } from './Transactions';

export function Review() {
  const { data, loading, error, reload } = useApi<any>('/api/transactions/review');
  const [run, busy] = useAction();
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={5} />;
  const items: any[] = data.items;
  return (
    <div className="stack">
      <div className="row between"><h1>Revisión</h1>{items.length > 0 && <button className="btn primary sm" disabled={busy} onClick={() => run(() => api.post('/api/transactions/review/confirm-all', { ids: items.filter((t) => !t.duplicate_of).map((t) => t.id) }), 'Movimientos confirmados')}>Confirmar todos (sin duplicados)</button>}</div>
      <p className="muted small" style={{ margin: 0 }}>Los movimientos detectados (correo, notificación) o importados no afectan tus saldos ni informes hasta que los confirmes. Puedes corregir categoría, importe o cuenta antes de confirmar.</p>
      {!items.length ? <section className="card"><Empty icon="check" title="Todo al día" text="No hay movimientos pendientes de revisión." action={<button className="btn" onClick={() => nav('/integraciones')}>Vincular mi Gmail</button>} /></section> : (
        <section className="card"><div className="list">
          {items.map((t) => (
            <div key={t.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <TxRow t={t} />
              <div className="row wrap" style={{ gap: 6, paddingLeft: 54 }}>
                <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.post(`/api/transactions/${t.id}/confirm`), 'Confirmado')}><Icon name="check" size={14} />Confirmar</button>
                <button className="btn sm" onClick={() => openTx({ kind: t.type === 'income' ? 'income' : 'expense', tx: t })}>Corregir</button>
                <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.del(`/api/transactions/${t.id}`), 'Descartado')}>Descartar</button>
              </div>
            </div>))}
        </div></section>)}
    </div>
  );
}
