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
import { Appearance } from './screens/Appearance';
import { Share } from './screens/Share';
import { Notifications, SearchSheet } from './screens/Misc';
import { LockScreen } from './components/Lock';
import { loadBrand } from './brand';
import { invalidate } from './ui';

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
  { to: '/recurrentes', label: 'Recurrentes', icon: 'repeat' }, { to: '/informes', label: 'Informes', icon: 'chart' }, { to: '/integraciones', label: 'Integraciones', icon: 'plug' }, { to: '/apariencia', label: 'Apariencia', icon: 'spark' }, { to: '/compartir', label: 'Compartir app', icon: 'send' },
];

const GOOGLE_ERRORS: Record<string, string> = {
  registration_closed: 'Para crear una cuenta necesitas una invitación. Pídele el enlace a quien administra la app.',
  invalid_invite: 'La invitación no es válida, venció o ya se usó.',
  email_unverified: 'Tu correo de Google no está verificado.',
  oauth_invalid: 'No se pudo validar el inicio de sesión con Google. Inténtalo de nuevo.',
  estado_vencido: 'El inicio de sesión tardó demasiado. Inténtalo de nuevo.',
  cancelado: 'Cancelaste el inicio de sesión con Google.',
  not_configured: 'El acceso con Google aún no está configurado en este servidor.',
  google_mismatch: 'Esa cuenta ya está vinculada a otro usuario de Google.',
  email_taken: 'Ya existe una cuenta con ese correo: inicia sesión con tu contraseña.',
};

function GoogleButton({ invite }: { invite?: string | null }) {
  return (
    <a className="btn block" href={`/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`} style={{ background: '#fff', color: '#1f1f1f', borderColor: '#dadce0' }}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Continuar con Google
    </a>
  );
}

function AuthScreen({ onDone }: { onDone: () => void }) {
  // Enlaces: /#/invitacion/<token> (compartido por el administrador) y /#/acceso?error|ticket (regreso de Google).
  const hash = location.hash.replace(/^#/, '');
  const invite = hash.startsWith('/invitacion/') ? decodeURIComponent(hash.split('/')[2] ?? '') : null;
  const back = new URLSearchParams(hash.startsWith('/acceso') ? hash.split('?')[1] ?? '' : '');
  const { data: st, loading } = useApi<{ has_users: boolean; registration_open: boolean; requires_code?: boolean; google_login?: boolean; invite?: { valid: boolean; inviter?: string } }>(`/api/auth/status${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`);
  const [mode, setMode] = useState<'login' | 'register'>(invite ? 'register' : 'login');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [name, setName] = useState(''); const [regCode, setRegCode] = useState('');
  const [err, setErr] = useState(back.get('error') ? GOOGLE_ERRORS[back.get('error')!] ?? 'No se pudo iniciar sesión con Google.' : '');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(back.get('ticket')); const [code, setCode] = useState('');
  useEffect(() => { if (st && !st.has_users) setMode('register'); }, [st]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (ticket) await api.post('/api/auth/login/2fa', { ticket, code });
      else if (mode === 'register') await api.post('/api/auth/register', { email, password: pw, display_name: name || 'Yo', ...(st?.requires_code ? { code: regCode } : {}), ...(invite ? { invite } : {}) });
      else {
        const r = await api.post('/api/auth/login', { email, password: pw });
        if (r.two_factor_required) { setTicket(r.ticket); setBusy(false); return; }
      }
      if (invite || back.toString()) history.replaceState(null, '', '/#/');
      onDone();
    } catch (er) { setErr(er instanceof ApiError ? er.message : 'Error inesperado'); } finally { setBusy(false); }
  };
  const inviteOk = invite && st?.invite?.valid;
  return (
    <main className="login">
      <div className="card glow fade-in">
        <div style={{ marginBottom: 18 }}><Logo size={44} /></div>
        <h1>{ticket ? 'Verificación en dos pasos' : mode === 'login' ? 'Bienvenido de nuevo' : inviteOk ? 'Te invitaron a probar la app' : 'Crea tu cuenta'}</h1>
        <p className="muted" style={{ margin: '6px 0 18px' }}>
          {ticket ? '' : mode === 'login' ? 'Inicia sesión para ver tu dinero.' : inviteOk ? `${st?.invite?.inviter ?? 'Alguien'} te invitó. Crea tu cuenta: tus datos son solo tuyos y nadie más los ve desde la app.` : 'Tus finanzas en un solo lugar.'}
        </p>
        {invite && st && !st.invite?.valid && <div className="alert warning" style={{ marginBottom: 14 }}><span className="small">Esta invitación no es válida, venció o ya se usó. Pide un enlace nuevo.</span></div>}
        {ticket ? (
          <form onSubmit={submit}>
            <p className="muted small" style={{ marginTop: 0 }}>Escribe el código de 6 dígitos de tu app de autenticación, o uno de tus códigos de recuperación.</p>
            <Field id="otp" label="Código de verificación"><input id="otp" className="input amount-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Verificando…' : 'Verificar'}</button>
            <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { setTicket(null); setCode(''); setErr(''); history.replaceState(null, '', '/#/'); }}>Volver</button>
          </form>
        ) : loading ? <LoadingBlock /> : (
          <>
            {st?.google_login && st.has_users && (mode === 'login' || inviteOk) && <><GoogleButton invite={inviteOk ? invite : null} /><div className="row" style={{ margin: '14px 0', gap: 10 }}><div className="hr grow" style={{ margin: 0 }} /><span className="xs faint">o con tu correo</span><div className="hr grow" style={{ margin: 0 }} /></div></>}
            <form onSubmit={submit}>
              {mode === 'register' && <Field id="name" label="Tu nombre"><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>}
              <Field id="email" label="Correo electrónico"><input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
              <Field id="pw" label="Contraseña" hint={mode === 'register' ? 'Mínimo 10 caracteres. Usa una frase larga.' : undefined}><input id="pw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : 1} required /></Field>
              {mode === 'register' && st?.requires_code && <Field id="regcode" label="Código de instalación" hint="Lo definiste al desplegar (REGISTRATION_CODE). Impide que otra persona cree la cuenta antes que tú."><input id="regcode" className="input" value={regCode} onChange={(e) => setRegCode(e.target.value)} autoComplete="off" required /></Field>}
              {err && <p className="err" role="alert">{err}</p>}
              <button className="btn primary block" disabled={busy || (Boolean(invite) && mode === 'register' && !inviteOk)}>{busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}</button>
              {st?.has_users && (st.registration_open || mode === 'register') && <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>{mode === 'login' ? 'Crear una cuenta nueva' : 'Ya tengo cuenta'}</button>}
            </form>
          </>
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
    case '/apariencia': screen = <Appearance />; break;
    case '/compartir': screen = <Share />; break;
    case '/invitacion': screen = <div className="empty"><h3>Ya tienes una sesión iniciada</h3><p>Para usar la invitación, cierra sesión primero o compártela con otra persona.</p><button className="btn" onClick={() => nav('/')}>Ir al inicio</button></div>; break;
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
  const [state, setState] = useState<'loading' | 'out' | 'in' | 'locked-boot'>('loading');
  const [locked, setLocked] = useState(false);
  const [me, setMe] = useState<any>(null);
  const load = async () => {
    try {
      const m = await api.get('/api/me');
      setFmt({ locale: m.locale, currency: m.currency, timezone: m.timezone });
      setMe(m); setLocked(false); setState('in');
      loadBrand(); // ahora con sesión: sabe si eres administrador
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState('out');
      else if (e instanceof ApiError && e.status === 423) { setLocked(true); setState((s) => (s === 'in' ? 'in' : 'locked-boot')); }
      else { toastError(e); setState('out'); }
    }
  };
  useEffect(() => {
    loadBrand();
    load();
    const out = () => setState('out');
    const lock = () => setLocked(true);
    // Al volver a la app tras un rato, el servidor decide si hay que pedir la huella otra vez.
    const vis = () => { if (document.visibilityState === 'visible') api.get('/api/lock/status').then((s) => { if (s.locked) setLocked(true); }).catch(() => {}); };
    window.addEventListener('nova:unauthorized', out); window.addEventListener('nova:locked', lock); document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('nova:unauthorized', out); window.removeEventListener('nova:locked', lock); document.removeEventListener('visibilitychange', vis); };
  }, []);
  const unlocked = () => { setLocked(false); if (state === 'locked-boot' || !me) load(); else invalidate(); };
  return (
    <>
      {state === 'loading' && <div className="login"><Logo size={56} /></div>}
      {state === 'out' && <AuthScreen onDone={load} />}
      {state === 'in' && me && <Shell me={me} />}
      {(locked || state === 'locked-boot') && state !== 'out' && <LockScreen onUnlocked={unlocked} />}
      <ConfirmHost /><Toasts />
    </>
  );
}
