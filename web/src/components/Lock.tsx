import { useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, api } from '../api';
import { Icon, Logo } from '../icons';
import { Field } from '../ui';

const FP = 'M12 11v3M8.5 8.2A4.5 4.5 0 0 1 16.5 11v1.5c0 2-.4 3.9-1.2 5.6M7.5 11c0 3.5-.6 5.6-1.5 7M12 7a4 4 0 0 0-4 4M12 14.5c0 2.6-.6 4.8-1.6 6.5M14.5 21c.4-1 .7-2.1.9-3.3M4.5 15c.3-1.2.5-2.5.5-4a7 7 0 0 1 12.6-4.2M19.4 9.5c.4 1.6.4 3.4.1 5';

export const biometricSupported = async () => {
  try { return Boolean(window.PublicKeyCredential) && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
};

/** Pantalla de bloqueo: la huella la verifica el teléfono y la firma resultante la valida el servidor. */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [st, setSt] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [usePw, setUsePw] = useState(false);
  const [pw, setPw] = useState('');
  const tried = useRef(false);

  const unlock = async () => {
    setErr(''); setBusy(true);
    try {
      const opts = await api.post('/api/lock/unlock/options');
      const resp = await startAuthentication({ optionsJSON: opts });
      await api.post('/api/lock/unlock/verify', { response: resp });
      onUnlocked();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'no_credentials') setUsePw(true);
      setErr(e?.name === 'NotAllowedError' ? 'Se canceló o no se reconoció la huella. Inténtalo de nuevo.' : e?.message ?? 'No se pudo desbloquear');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    api.get('/api/lock/status').then((s) => {
      setSt(s);
      if (!s.credentials.length) setUsePw(true);
      // Se intenta abrir la huella al instante; si el navegador exige un toque, queda el botón.
      else if (!tried.current) { tried.current = true; unlock(); }
    }).catch(() => setSt({ credentials: [] }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPw = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api.post('/api/lock/unlock/password', { password: pw }); onUnlocked(); }
    catch (er: any) { setErr(er?.message ?? 'Contraseña incorrecta'); }
    finally { setBusy(false); }
  };

  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="App bloqueada">
      <div className="inner fade-in">
        <Logo size={52} />
        <h1 style={{ marginTop: 18 }}>{st?.display_name ? `Hola, ${st.display_name}` : 'App bloqueada'}</h1>
        <p className="muted" style={{ marginTop: 6 }}>Desbloquea para ver tus finanzas.</p>
        {!usePw ? (
          <>
            <button className="fp" onClick={unlock} disabled={busy} aria-label="Desbloquear con huella">
              <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d={FP} /></svg>
            </button>
            <button className="btn primary block" onClick={unlock} disabled={busy}>{busy ? 'Esperando la huella…' : 'Desbloquear con huella'}</button>
            {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
            <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { setUsePw(true); setErr(''); }}>Usar mi contraseña</button>
          </>
        ) : (
          <form onSubmit={submitPw} style={{ marginTop: 22, textAlign: 'left' }}>
            <Field id="lockpw" label="Contraseña"><input id="lockpw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus required /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Verificando…' : 'Desbloquear'}</button>
            {st?.credentials?.length > 0 && <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { setUsePw(false); setErr(''); }}><Icon name="lock" size={16} />Volver a la huella</button>}
          </form>
        )}
        <button className="btn ghost sm" style={{ marginTop: 18 }} onClick={async () => { await api.post('/api/auth/logout').catch(() => {}); location.reload(); }}>Cerrar sesión</button>
      </div>
    </div>
  );
}
