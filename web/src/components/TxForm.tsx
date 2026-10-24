import { useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { ACCOUNT_TYPES, NATURE_LABEL, PAY_METHODS, fromMinor, isoLocalInput, money, shownBalance, toMinor } from '../format';
import { Icon } from '../icons';
import { Field, Sheet, invalidate, toast, toastError, useApi } from '../ui';

type Kind = 'expense' | 'income' | 'transfer';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

const defaultMethod = (type?: string) => ({ cash: 'Efectivo', debit_card: 'Tarjeta de débito', credit_card: 'Tarjeta de crédito', bank: 'Transferencia', wallet: 'Billetera digital' } as Record<string, string>)[type ?? ''] ?? '';

export function TxForm({ initialKind = 'expense', tx, onClose }: { initialKind?: Kind; tx?: any; onClose: () => void }) {
  const editing = Boolean(tx);
  const { data: accounts } = useApi<any[]>('/api/accounts');
  const { data: cats } = useApi<any[]>('/api/categories');
  const [kind, setKind] = useState<Kind>(tx && ['income', 'expense', 'transfer'].includes(tx.type) ? tx.type : initialKind);
  const [amount, setAmount] = useState(tx ? fromMinor(Math.abs(tx.amount)) : '');
  const [toAmount, setToAmount] = useState(tx?.to_amount ? fromMinor(tx.to_amount) : '');
  const [accountId, setAccountId] = useState<string>(tx?.account_id ?? lsGet('nova.lastAccount') ?? '');
  const [toAccountId, setToAccountId] = useState<string>(tx?.to_account_id ?? '');
  const [categoryId, setCategoryId] = useState<string>(tx?.category_id ?? '');
  const [merchant, setMerchant] = useState(tx?.merchant ?? '');
  const [method, setMethod] = useState(tx?.payment_method ?? '');
  const [when, setWhen] = useState(isoLocalInput(tx ? new Date(tx.occurred_at) : new Date()));
  const [description, setDescription] = useState(tx?.description ?? '');
  const [tags, setTags] = useState((tx?.tags ?? []).join(', '));
  const [nature, setNature] = useState(tx?.nature ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [more, setMore] = useState(Boolean(tx?.description || tx?.tags?.length || tx?.nature));
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const active = useMemo(() => (accounts ?? []).filter((a) => !a.archived), [accounts]);
  const acc = active.find((a) => a.id === (accountId || active[0]?.id));
  const toAcc = active.find((a) => a.id === toAccountId);
  const catList = useMemo(() => (cats ?? []).filter((c) => !c.archived && c.kind === (kind === 'income' ? 'income' : 'expense')), [cats, kind]);
  const tops = catList.filter((c) => !c.parent_id);
  const subs = catList.filter((c) => c.parent_id && (c.parent_id === categoryId || catList.find((t) => t.id === categoryId)?.parent_id === c.parent_id));
  const fx = kind === 'transfer' && acc && toAcc && acc.currency !== toAcc.currency;
  const editableType = !tx || ['income', 'expense', 'transfer'].includes(tx.type);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const m = toMinor(amount);
    const fe: Record<string, string> = {};
    if (!m || m <= 0) fe.amount = 'Escribe un importe mayor que cero';
    if (!acc) fe.account_id = 'Elige una cuenta';
    if (kind === 'transfer' && !toAccountId) fe.to_account_id = 'Elige la cuenta de destino';
    if (fx && !toMinor(toAmount)) fe.to_amount = 'Indica cuánto se recibe en la moneda de destino';
    setErrs(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    const body: any = {
      type: editableType ? kind : tx.type, amount: tx && !editableType ? tx.amount : m, account_id: acc!.id, occurred_at: new Date(when).toISOString(),
      merchant: merchant.trim() || null, payment_method: method || null, description: description.trim() || null,
      tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean), nature: nature || null,
    };
    if (kind !== 'transfer') { body.category_id = categoryId || null; body.to_account_id = null; body.to_amount = null; }
    else { body.to_account_id = toAccountId; body.to_amount = fx ? toMinor(toAmount) : null; body.category_id = null; }
    try {
      if (editing) {
        await api.patch(`/api/transactions/${tx.id}`, body);
        toast('Movimiento actualizado', 'ok');
      } else {
        const r = await api.post('/api/transactions', body);
        lsSet('nova.lastAccount', acc!.id);
        if (file) { try { await api.upload(`/api/transactions/${r.tx.id}/receipt`, file); } catch (er) { toastError(er); } }
        toast(`${kind === 'expense' ? 'Gasto' : kind === 'income' ? 'Ingreso' : 'Transferencia'} de ${money(m, acc!.currency)} registrado`, 'ok', {
          label: 'Deshacer', run: () => api.post(`/api/transactions/${r.tx.id}/void`, { reason: 'Deshecho al instante' }).then(() => { invalidate(); toast('Movimiento anulado', 'info'); }).catch(toastError),
        });
      }
      invalidate(); onClose();
    } catch (er) {
      if (er instanceof ApiError && er.fields) setErrs(er.fields);
      toastError(er);
    } finally { setBusy(false); }
  };

  const title = editing ? 'Editar movimiento' : kind === 'expense' ? 'Nuevo gasto' : kind === 'income' ? 'Nuevo ingreso' : 'Transferencia';
  return (
    <Sheet title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {editableType && !editing && (
          <div className="seg" role="tablist" aria-label="Tipo de movimiento" style={{ marginBottom: 16 }}>
            {(['expense', 'income', 'transfer'] as Kind[]).map((k) => (
              <button type="button" key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setCategoryId(''); }}>{k === 'expense' ? 'Gasto' : k === 'income' ? 'Ingreso' : 'Transferir'}</button>
            ))}
          </div>
        )}
        <Field id="amount" label={`Importe${acc ? ` (${acc.currency})` : ''}`} error={errs.amount}>
          <input id="amount" className="input amount-input" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={Boolean(errs.amount)} aria-describedby={errs.amount ? 'amount-err' : undefined} disabled={!editableType && tx?.type === 'adjustment'} />
        </Field>

        {kind !== 'transfer' && editableType && (
          <div className="field">
            <span className="lbl">Categoría</span>
            <div className="chips" role="group" aria-label="Categoría">
              {tops.map((c) => <button type="button" key={c.id} className="chip" aria-pressed={categoryId === c.id || catList.find((x) => x.id === categoryId)?.parent_id === c.id} onClick={() => setCategoryId(categoryId === c.id ? '' : c.id)}>{c.name}</button>)}
            </div>
            {subs.length > 0 && <div className="chips" role="group" aria-label="Subcategoría" style={{ marginTop: 6 }}>{subs.map((c) => <button type="button" key={c.id} className="chip" aria-pressed={categoryId === c.id} onClick={() => setCategoryId(c.id)}>{c.name}</button>)}</div>}
          </div>
        )}

        <div className="grid cols-2" style={{ gap: 0 }}>
          <Field id="account" label={kind === 'transfer' ? 'Desde la cuenta' : kind === 'income' ? 'Ingresa a' : 'Pagado con'} error={errs.account_id}>
            <select id="account" className="input" value={acc?.id ?? ''} onChange={(e) => { setAccountId(e.target.value); if (!method) setMethod(defaultMethod(active.find((a) => a.id === e.target.value)?.type)); }}>
              {active.map((a) => <option key={a.id} value={a.id}>{a.name} · {ACCOUNT_TYPES[a.type]} ({money(shownBalance(a), a.currency)})</option>)}
            </select>
          </Field>
          {kind === 'transfer' ? (
            <Field id="to" label="Hacia la cuenta" error={errs.to_account_id}>
              <select id="to" className="input" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">Elige…</option>
                {active.filter((a) => a.id !== acc?.id).map((a) => <option key={a.id} value={a.id}>{a.name} · {ACCOUNT_TYPES[a.type]}</option>)}
              </select>
            </Field>
          ) : (
            <Field id="method" label="Método de pago">
              <select id="method" className="input" value={method || defaultMethod(acc?.type)} onChange={(e) => setMethod(e.target.value)}>
                <option value="">—</option>{PAY_METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
          )}
        </div>
        {fx && <Field id="toamt" label={`Importe recibido (${toAcc!.currency})`} error={errs.to_amount}><input id="toamt" className="input" inputMode="decimal" value={toAmount} onChange={(e) => setToAmount(e.target.value)} /></Field>}
        {kind === 'transfer' && <p className="hint" style={{ marginTop: -6 }}>Las transferencias entre tus cuentas no cuentan como ingreso ni gasto.</p>}

        {kind !== 'transfer' && editableType && <Field id="merchant" label={kind === 'income' ? 'Origen / pagador' : 'Comercio o destinatario'}><input id="merchant" className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={120} autoComplete="off" /></Field>}
        <Field id="when" label="Fecha y hora" error={errs.occurred_at}><input id="when" type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>

        <button type="button" className="btn ghost sm" onClick={() => setMore(!more)} aria-expanded={more} style={{ marginBottom: 12 }}>{more ? 'Menos detalles' : 'Más detalles'}</button>
        {more && (
          <div className="fade-in">
            <Field id="desc" label="Descripción"><input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
            <Field id="tags" label="Etiquetas" hint="Separadas por comas"><input id="tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
            {kind === 'expense' && <Field id="nature" label="Naturaleza del gasto" hint="Si lo dejas vacío se usa la de la categoría"><select id="nature" className="input" value={nature} onChange={(e) => setNature(e.target.value)}><option value="">Según categoría</option>{Object.entries(NATURE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
            {!editing && <Field id="rcpt" label="Comprobante (foto o PDF, máx. 3 MB)"><input id="rcpt" type="file" className="input" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={(e) => { const f = e.target.files?.[0] ?? null; if (f && f.size > 3 * 1024 * 1024) { toast('El archivo supera 3 MB', 'error'); e.target.value = ''; return; } setFile(f); }} /></Field>}
          </div>
        )}
        <button className="btn primary block" disabled={busy || !active.length}>{busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Guardar'}</button>
        {!active.length && accounts && <p className="err">Primero crea una cuenta en Perfil → Cuentas.</p>}
      </form>
    </Sheet>
  );
}

export function RefundForm({ tx, onClose }: { tx: any; onClose: () => void }) {
  const [amount, setAmount] = useState(fromMinor(tx.amount));
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Registrar devolución" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>Corrige el gasto de {tx.merchant ?? 'este movimiento'} ({money(tx.amount, tx.currency)}) sin borrarlo: el gasto neto baja y el dinero vuelve a la cuenta.</p>
      <Field id="ramount" label="Importe devuelto"><input id="ramount" className="input amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <button className="btn primary block" disabled={busy} onClick={async () => {
        const m = toMinor(amount); if (!m) return toast('Importe no válido', 'error');
        setBusy(true);
        try { await api.post('/api/transactions', { type: 'refund', amount: m, account_id: tx.account_id, refund_of: tx.id }); toast('Devolución registrada', 'ok'); invalidate(); onClose(); } catch (e) { toastError(e); } finally { setBusy(false); }
      }}>Registrar devolución</button>
    </Sheet>
  );
}
