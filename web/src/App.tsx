import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import { setFmt } from './format';
import { Icon, Logo } from './icons';
import { ConfirmHost, Field, LoadingBlock, Sheet, Toasts, nav, toastError, useApi, useRoute } from './ui';
import { TxForm } from './components/TxForm';
import { Home } from './screens/Home';
import { Transactions } from './screens/Transactions';
import { Budgets } from './screens/Budgets';
import { Ai } from './screens/Ai';
import { Profile } from './screens/Profile';
import { Accounts } from './screens/Accounts';
import { Goals } from './screens/Goals';
import { Debts } from './screens/Debts';
import { Recurring } from './screens/Recurring';
import { Reports } from './screens/Reports';
import { Integrations } from './screens/Integrations';
import { Review } from './screens/Review';
import { Notifications, SearchSheet } from './screens/Misc';

// Estado global mínimo para abrir el formulario rápido desde cualquier pantalla.
type TxState = { kind: 'expense' | 'income' | 'transfer'; tx?: any } | null;
let txState: TxState = null;
const txSubs = new Set<() => void>();
export const openTx = (s: NonNullable<TxState>) => { txState = s; txSubs.forEach((f) => f()); };
const closeTx = () => { txState = null; txSubs.forEach((f) => f()); };

const MAIN = [
  { to: '/', label: 'Inicio', icon: 'home' },
  { to: '/movimientos', label: 'Movimientos', icon: 'list' },
  { to: '/ia', label: 'NOVA AI', icon: 'spark', ai: true },
  { to: '/presupuestos', label: 'Presupuestos', icon: 'pie' },
  { to: '/perfil', label: 'Perfil', icon: 'user' },
];
const MORE = [
  { to: '/cuentas', label: 'Cuentas', icon: 'wallet' }, { to: '/metas', label: 'Metas', icon: 'target' }, { to: '/deudas', label: 'Deudas', icon: 'scale' },
  { to: '/recurrentes', label: 'Recurrentes', icon: 'repeat' }, { to: '/informes', label: 'Informes', icon: 'chart' }, { to: '/integraciones', label: 'Integraciones', icon: 'plug' },
];

function AuthScreen({ onDone }: { onDone: () => void }) {
  const { data: st, loading } = useApi<{ has_users: boolean; registration_open: boolean }>('/api/auth/status');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [name, setName] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null); const [code, setCode] = useState('');
  useEffect(() => { if (st && !st.has_users) setMode('register'); }, [st]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (mode === 'register') await api.post('/api/auth/register', { email, password: pw, display_name: name || 'Yo' });
      else if (ticket) await api.post('/api/auth/login/2fa', { ticket, code });
      else {
        const r = await api.post('/api/auth/login', { email, password: pw });
        if (r.two_factor_required) { setTicket(r.ticket); setBusy(false); return; }
      }
      onDone();
    } catch (er) { setErr(er instanceof ApiError ? er.message : 'Error inesperado'); } finally { setBusy(false); }
  };
  return (
    <main className="login">
      <div className="card glow fade-in">
        <div style={{ marginBottom: 18 }}><Logo size={44} /></div>
        <h1>{mode === 'login' ? 'Bienvenido de nuevo' : 'Crea tu centro financiero'}</h1>
        <p className="muted" style={{ margin: '6px 0 18px' }}>{mode === 'login' ? 'Inicia sesión para ver tu dinero.' : 'Tus datos se guardan en tu propio servidor.'}</p>
        {ticket ? (
          <form onSubmit={submit}>
            <p className="muted small" style={{ marginTop: 0 }}>Escribe el código de 6 dígitos de tu app de autenticación, o uno de tus códigos de recuperación.</p>
            <Field id="otp" label="Código de verificación"><input id="otp" className="input amount-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Verificando…' : 'Verificar'}</button>
            <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { setTicket(null); setCode(''); setErr(''); }}>Volver</button>
          </form>
        ) : loading ? <LoadingBlock /> : (
          <form onSubmit={submit}>
            {mode === 'register' && <Field id="name" label="Tu nombre"><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>}
            <Field id="email" label="Correo electrónico"><input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
            <Field id="pw" label="Contraseña" hint={mode === 'register' ? 'Mínimo 10 caracteres. Usa una frase larga.' : undefined}><input id="pw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : 1} required /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}</button>
            {st?.has_users && st.registration_open && <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Crear una cuenta nueva' : 'Ya tengo cuenta'}</button>}
          </form>
        )}
      </div>
    </main>
  );
}

function Shell({ me }: { me: any }) {
  const { path } = useRoute();
  const tx = useSyncExternalStore((f) => { txSubs.add(f); return () => txSubs.delete(f); }, () => txState);
  const [search, setSearch] = useState(false);
  const [notif, setNotif] = useState(false);
  const { data: ns } = useApi<any[]>('/api/notifications?unread=true');
  const unread = ns?.length ?? 0;
  const base = '/' + (path.split('/')[1] ?? '');
  const isMain = MAIN.some((m) => m.to === base || (m.to === '/' && path === '/'));

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    // Atajo desde el manifiesto: /#/movimientos?nuevo=gasto
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (q.get('nuevo')) { openTx({ kind: q.get('nuevo') === 'ingreso' ? 'income' : 'expense' }); }
  }, []);

  let screen;
  switch (base) {
    case '/': screen = <Home me={me} />; break;
    case '/movimientos': screen = <Transactions />; break;
    case '/presupuestos': screen = <Budgets />; break;
    case '/ia': screen = <Ai />; break;
    case '/perfil': screen = <Profile me={me} />; break;
    case '/cuentas': screen = <Accounts />; break;
    case '/metas': screen = <Goals />; break;
    case '/deudas': screen = <Debts />; break;
    case '/recurrentes': screen = <Recurring />; break;
    case '/informes': screen = <Reports />; break;
    case '/integraciones': screen = <Integrations />; break;
    case '/revision': screen = <Review />; break;
    default: screen = <div className="empty"><h3>Pantalla no encontrada</h3><button className="btn" onClick={() => nav('/')}>Ir al inicio</button></div>;
  }
  const NavLink = ({ it }: { it: (typeof MAIN)[number] }) => (
    <a href={`#${it.to}`} className={`navitem ${(it as any).ai ? 'ai' : ''}`} aria-current={(it.to === '/' ? path === '/' : base === it.to) ? 'page' : undefined}>
      {(it as any).ai ? <span className="orb"><Icon name={it.icon} size={22} /></span> : <Icon name={it.icon} />}<span className="l">{it.label}</span>
    </a>
  );
  return (
    <div className="app">
      <nav className="side" aria-label="Navegación principal">
        <div style={{ padding: '4px 10px 14px' }}><Logo /></div>
        {MAIN.map((m) => <NavLink key={m.to} it={m} />)}
        <div className="sep" /><div className="group">Gestión</div>
        {MORE.map((m) => <a key={m.to} href={`#${m.to}`} className="navitem" aria-current={base === m.to ? 'page' : undefined}><Icon name={m.icon} /><span>{m.label}</span></a>)}
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>
        <main className="main" id="contenido">
          <header className="topbar">
            {!isMain || path !== '/' ? <button className="iconbtn" aria-label="Volver" onClick={() => (isMain ? nav('/') : history.length > 1 ? history.back() : nav('/perfil'))} style={{ transform: 'rotate(180deg)' }}><Icon name="chevron" /></button> : null}
            <div className="grow">{path === '/' ? <Logo /> : null}</div>
            <button className="iconbtn" aria-label="Buscar (Ctrl+K)" onClick={() => setSearch(true)}><Icon name="search" /></button>
            <button className="iconbtn" aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ''}`} onClick={() => setNotif(true)}><Icon name="bell" />{unread > 0 && <span className="dot">{unread > 9 ? '9+' : unread}</span>}</button>
          </header>
          {screen}
        </main>
      </div>
      {isMain && base !== '/ia' && base !== '/perfil' && <button className="fab" aria-label="Agregar movimiento" onClick={() => openTx({ kind: 'expense' })}><Icon name="plus" size={28} /></button>}
      <nav className="bottomnav" aria-label="Navegación principal">{MAIN.map((m) => <NavLink key={m.to} it={m} />)}</nav>
      {tx && <TxForm initialKind={tx.kind} tx={tx.tx} onClose={closeTx} />}
      {search && <SearchSheet onClose={() => setSearch(false)} />}
      {notif && <Notifications onClose={() => setNotif(false)} />}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [me, setMe] = useState<any>(null);
  const load = async () => {
    try { const m = await api.get('/api/me'); setFmt({ locale: m.locale, currency: m.currency, timezone: m.timezone }); setMe(m); setState('in'); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setState('out'); else { toastError(e); setState('out'); } }
  };
  useEffect(() => { load(); const f = () => setState('out'); window.addEventListener('nova:unauthorized', f); return () => window.removeEventListener('nova:unauthorized', f); }, []);
  return (
    <>
      {state === 'loading' && <div className="login"><Logo size={56} /></div>}
      {state === 'out' && <AuthScreen onDone={load} />}
      {state === 'in' && <Shell me={me} />}
      <ConfirmHost /><Toasts />
    </>
  );
}
