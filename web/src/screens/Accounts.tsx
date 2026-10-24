import { useEffect, useState } from 'react';
import { api } from '../api';
import { ACCOUNT_TYPES, fromMinor, money, toMinor, todayKey, ymd } from '../format';
import { Icon } from '../icons';
import { Empty, ErrorBlock, Field, LoadingBlock, Sheet, confirmDialog, useAction, useApi, useRoute } from '../ui';
import { BANKS, bankByCode } from '../banks';
import { CardFace, WalletStack } from '../components/Wallet';

const today = todayKey;

function AccountForm({ a, onClose }: { a?: any; onClose: () => void }) {
  const [name, setName] = useState(a?.name ?? ''); const [type, setType] = useState(a?.type ?? 'debit_card'); const [cur, setCur] = useState(a?.currency ?? '');
  const [open, setOpen] = useState(a ? fromMinor(a.opening_balance) : ''); const [date, setDate] = useState(a?.opening_date ?? today());
  const [limit, setLimit] = useState(a?.credit_limit != null ? fromMinor(a.credit_limit) : ''); const [errs, setErrs] = useState<Record<string, string>>({});
  const [bank, setBank] = useState<string>(a?.bank_code ?? ''); const [net, setNet] = useState<string>(a?.card_network ?? ''); const [last4, setLast4] = useState<string>(a?.last4 ?? '');
  const [custom, setCustom] = useState<boolean>(Boolean(a?.card_colors)); const initial = (a?.card_colors ?? '').split(',');
  const [c1, setC1] = useState(initial[0] || '#1A2029'); const [c2, setC2] = useState(initial[1] || '#C6FF3D');
  const [run, busy] = useAction();
  const isCard = type === 'debit_card' || type === 'credit_card';
  // Los últimos 4 dígitos también sirven en cuentas bancarias: los avisos por correo los traen ("cuenta *****6480").
  const hasDigits = isCard || type === 'bank' || type === 'savings';
  const pickBank = (code: string) => {
    setBank(code);
    const b = bankByCode(code);
    if (b && !name.trim()) setName(b.kind === 'cash' ? 'Efectivo' : `${b.name}${type === 'credit_card' ? ' Crédito' : type === 'debit_card' ? ' Débito' : ''}`);
    if (b?.kind === 'cash') setType('cash');
    if (b?.kind === 'wallet') setType('wallet');
  };
  const preview = { name: name || 'Mi tarjeta', type, currency: cur || 'HNL', balance: toMinor(open) ?? 0, available_credit: type === 'credit_card' && limit ? (toMinor(limit) ?? 0) + Math.min(toMinor(open) ?? 0, 0) : null, owed: 0, bank_code: bank || null, card_network: isCard ? net || null : null, last4: hasDigits && last4.length === 4 ? last4 : null, card_colors: custom ? `${c1},${c2}` : null };
  const save = async () => {
    const fe: Record<string, string> = {};
    if (!name.trim()) fe.name = 'Ponle un nombre';
    const ob = open.trim() ? toMinor(open) : 0; if (ob == null) fe.opening_balance = 'Importe no válido';
    if (last4 && !/^\d{4}$/.test(last4)) fe.last4 = 'Escribe solo los últimos 4 dígitos';
    setErrs(fe); if (Object.keys(fe).length) return;
    const look = { bank_code: bank || null, card_network: isCard ? net || null : null, last4: hasDigits && last4 ? last4 : null, card_colors: custom ? `${c1},${c2}` : null };
    const body: any = { name: name.trim(), opening_balance: ob, opening_date: date, ...look, ...(type === 'credit_card' ? { credit_limit: limit ? toMinor(limit) : null } : {}) };
    const r = await run(() => a ? api.patch(`/api/accounts/${a.id}`, body) : api.post('/api/accounts', { ...body, type, ...(cur ? { currency: cur.toUpperCase() } : {}) }), a ? 'Cuenta actualizada' : 'Cuenta creada');
    if (r) onClose();
  };
  return (
    <Sheet title={a ? 'Editar cuenta' : 'Nueva cuenta o tarjeta'} onClose={onClose} wide>
      <div style={{ maxWidth: 360, margin: '0 auto 16px' }}><CardFace a={preview} /></div>
      {!a && <Field id="at" label="Tipo"><select id="at" className="input" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
      <div className="field">
        <span className="lbl">¿De qué banco es?</span>
        <div className="bankgrid" role="group" aria-label="Banco o billetera">
          {BANKS.map((b) => (
            <button type="button" key={b.code} className="bankopt" aria-pressed={bank === b.code} onClick={() => pickBank(b.code)}>
              <span className="sw" style={{ background: `linear-gradient(135deg, ${b.colors[0]} 55%, ${b.colors[1]} 56%, ${b.colors[2]})` }} aria-hidden="true" />
              {b.name}
            </button>
          ))}
        </div>
        <span className="hint">Colores aproximados de cada marca (sin logotipos). Puedes personalizarlos abajo.</span>
      </div>
      <Field id="an" label="Nombre" error={errs.name}><input id="an" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: BAC Débito, Ficohsa Crédito" /></Field>
      {hasDigits && (
        <div className="grid cols-2" style={{ gap: 0 }}>
          {isCard && <div className="field"><span className="lbl">Red</span><div className="chips" role="group" aria-label="Red de la tarjeta">{[['visa', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'AMEX'], ['', 'Ninguna']].map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={net === k} onClick={() => setNet(k)}>{l}</button>)}</div></div>}
          <Field id="al4" label="Últimos 4 dígitos (recomendado)" error={errs.last4} hint={`Así los avisos del banco por correo se registran en ${isCard ? 'esta tarjeta' : 'esta cuenta'}. Nunca escribas el número completo.`}><input id="al4" className="input" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} placeholder="1824" /></Field>
        </div>
      )}
      <label className="switch"><span>Personalizar colores</span><input type="checkbox" role="switch" checked={custom} onChange={(e) => setCustom(e.target.checked)} /></label>
      {custom && <div className="row" style={{ gap: 12, marginBottom: 12 }}><label className="small">Principal <input type="color" value={c1} onChange={(e) => setC1(e.target.value)} aria-label="Color principal" /></label><label className="small">Acento <input type="color" value={c2} onChange={(e) => setC2(e.target.value)} aria-label="Color de acento" /></label></div>}
      {!a && <Field id="ac" label="Moneda" hint="Vacío = tu moneda principal. Los totales solo suman la moneda principal (o las que tengan tipo de cambio)."><input id="ac" className="input" value={cur} maxLength={3} onChange={(e) => setCur(e.target.value)} placeholder="HNL" /></Field>}
      <div className="grid cols-2" style={{ gap: 0 }}>
        <Field id="ao" label={type === 'credit_card' ? 'Deuda inicial (negativo)' : 'Saldo inicial'} error={errs.opening_balance} hint={type === 'credit_card' ? 'Ej.: -1500 si ya debes 1,500' : undefined}><input id="ao" className="input" inputMode="decimal" value={open} onChange={(e) => setOpen(e.target.value)} /></Field>
        <Field id="ad" label="Fecha del saldo inicial"><input id="ad" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {type === 'credit_card' && <Field id="al" label="Límite de crédito"><input id="al" className="input" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>}
      {a && <p className="hint">Cambiar el saldo inicial recalcula todo el historial de esta cuenta. Queda registrado en la auditoría.</p>}
      <button className="btn primary block" disabled={busy} onClick={save}>Guardar</button>
    </Sheet>
  );
}

function Reconcile({ a, onClose }: { a: any; onClose: () => void }) {
  const [bank, setBank] = useState(''); const [date, setDate] = useState(today()); const [adj, setAdj] = useState(true); const [run, busy] = useAction();
  const m = toMinor(bank);
  return (
    <Sheet title={`Conciliar ${a.name}`} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>Compara el saldo que calcula la app ({money(a.balance, a.currency)}) con el que muestra tu banco o el efectivo contado. Guardamos ambos por separado.</p>
      <Field id="rb" label="Saldo real (banco o conteo)"><input id="rb" className="input amount-input" inputMode="decimal" value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
      <Field id="rd" label="Saldo al cierre del día"><input id="rd" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} max={today()} /></Field>
      <label className="switch"><span>Crear un ajuste de saldo si hay diferencia<div className="hint">El ajuste no cuenta como ingreso ni gasto.</div></span><input type="checkbox" role="switch" checked={adj} onChange={(e) => setAdj(e.target.checked)} /></label>
      <button className="btn primary block" disabled={busy || m == null} onClick={() => run(() => api.post(`/api/accounts/${a.id}/reconcile`, { bank_balance: m, as_of: date, create_adjustment: adj }), 'Conciliación guardada').then((r) => { if (r) onClose(); })}>Conciliar</button>
    </Sheet>
  );
}

export function Accounts() {
  const { data, loading, error, reload } = useApi<any[]>('/api/accounts');
  const { query } = useRoute();
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [rec, setRec] = useState<any>(null); const [run] = useAction();
  useEffect(() => { if (query.get('nueva')) setEdit('new'); }, []); // eslint-disable-line
  if (error && !data) return <ErrorBlock error={error} retry={reload} />;
  if (loading && !data) return <LoadingBlock rows={4} />;
  const active = data!.filter((a) => !a.archived), arch = data!.filter((a) => a.archived);
  const Card = ({ a }: { a: any }) => (
    <div className="card">
      <div style={{ maxWidth: 300, marginBottom: 12 }}><CardFace a={a} /></div>
      <div className="row between"><div><h3>{a.name}</h3><div className="small muted">{ACCOUNT_TYPES[a.type]} · {a.currency}</div></div><div className={`num ${a.balance < 0 ? 'neg' : ''}`} style={{ fontSize: '1.4rem', fontWeight: 700 }}>{money(a.balance, a.currency)}</div></div>
      <div className="hr" />
      <div className="stack small" style={{ gap: 4 }}>
        <div className="row between"><span className="muted">Saldo inicial ({ymd(a.opening_date)})</span><span className="num">{money(a.opening_balance, a.currency)}</span></div>
        <div className="row between"><span className="muted">Saldo contable (calculado)</span><span className="num">{money(a.balance, a.currency)}</span></div>
        <div className="row between"><span className="muted">Confirmado por el banco</span><span className="num">{a.last_reconciliation ? `${money(a.bank_confirmed_balance, a.currency)} · ${ymd(a.last_reconciliation.as_of)}` : 'nunca conciliada'}</span></div>
        {a.last_reconciliation && a.last_reconciliation.difference !== 0 && <div className="row between"><span className="warn">Diferencia al conciliar</span><span className="num warn">{money(a.last_reconciliation.difference, a.currency)}</span></div>}
        {a.reserved_virtual > 0 && <div className="row between"><span className="muted">Reservado en metas (virtual)</span><span className="num">{money(a.reserved_virtual, a.currency)}</span></div>}
        {a.type === 'credit_card' && <>
          <div className="row between"><span className="muted">Saldo pendiente de pago</span><span className="num neg">{money(a.owed, a.currency)}</span></div>
          {a.available_credit != null && <div className="row between"><span className="muted">Crédito disponible</span><span className="num pos">{money(a.available_credit, a.currency)}</span></div>}
          <p className="hint">Pagar la tarjeta es una transferencia desde tu cuenta: cancela la deuda sin volver a contar las compras como gasto.</p>
        </>}
        {a.pending_count > 0 && <div className="row between"><span className="muted">Movimientos por revisar</span><span className="badge warn">{a.pending_count}</span></div>}
      </div>
      <div className="row wrap" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => setRec(a)}>Conciliar</button><button className="btn sm" onClick={() => setEdit(a)}><Icon name="edit" size={14} />Editar</button>
        <button className="btn sm ghost" onClick={async () => { if (a.archived || await confirmDialog(`"${a.name}" se archivará y dejará de sumar en tus totales. Su historial se conserva.`, 'Archivar')) run(() => api.patch(`/api/accounts/${a.id}`, { archived: !a.archived }), a.archived ? 'Cuenta restaurada' : 'Cuenta archivada'); }}>{a.archived ? 'Restaurar' : 'Archivar'}</button>
      </div>
    </div>
  );
  return (
    <div className="stack">
      <div className="row between"><h1>Cuentas</h1><button className="btn primary sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Nueva</button></div>
      {active.length > 0 && <WalletStack accounts={active} />}
      {!active.length && <section className="card"><Empty icon="wallet" title="Aún no tienes cuentas" text="Crea tu efectivo y tus cuentas con su saldo actual para que los totales sean reales." action={<button className="btn primary" onClick={() => setEdit('new')}>Crear cuenta</button>} /></section>}
      <div className="grid cols-2">{active.map((a) => <Card key={a.id} a={a} />)}</div>
      {arch.length > 0 && <><h3 className="muted">Archivadas</h3><div className="grid cols-2">{arch.map((a) => <Card key={a.id} a={a} />)}</div></>}
      {edit && <AccountForm a={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {rec && <Reconcile a={rec} onClose={() => setRec(null)} />}
    </div>
  );
}
