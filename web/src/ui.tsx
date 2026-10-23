import { ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import { Icon } from './icons';

// ---------- Invalidación global de datos ----------
let version = 0;
const subs = new Set<() => void>();
export const invalidate = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
const snap = () => version;

export function useApi<T = any>(url: string | null, deps: unknown[] = []) {
  const v = useSyncExternalStore(subscribe, snap);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    try { const d = await api.get<T>(url); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError(e as ApiError); }
    finally { if (my === seq.current) setLoading(false); }
  }, [url]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, v, ...deps]);
  return { data, error, loading, reload: load };
}

// ---------- Router por hash ----------
export function useRoute() {
  const get = () => { const h = location.hash.replace(/^#/, '') || '/'; const [p, q] = h.split('?'); return { path: p, query: new URLSearchParams(q ?? '') }; };
  const [r, setR] = useState(get);
  useEffect(() => { const f = () => setR(get()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
}
export const nav = (to: string) => { location.hash = to; window.scrollTo({ top: 0 }); };

// ---------- Toasts ----------
type ToastItem = { id: number; msg: string; kind: 'ok' | 'error' | 'info'; action?: { label: string; run: () => void } };
let toasts: ToastItem[] = [];
const tsubs = new Set<() => void>();
export function toast(msg: string, kind: ToastItem['kind'] = 'info', action?: ToastItem['action']) {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, msg, kind, action }];
  tsubs.forEach((f) => f());
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); tsubs.forEach((f) => f()); }, action ? 7000 : 4200);
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : 'Ocurrió un error', 'error');
export function Toasts() {
  const list = useSyncExternalStore((f) => { tsubs.add(f); return () => tsubs.delete(f); }, () => toasts);
  return (
    <div className="toasts" aria-live="polite" role="status">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warn' : t.kind === 'ok' ? 'check' : 'info'} size={20} />
          <span className="grow small">{t.msg}</span>
          {t.action && <button className="btn sm ghost" onClick={() => { t.action!.run(); toasts = toasts.filter((x) => x.id !== t.id); tsubs.forEach((f) => f()); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

// ---------- Sheet (hoja inferior / diálogo) ----------
export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input,select,textarea,button.btn')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = ''; prev?.focus(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { maxWidth: 760 } : undefined}>
        <div className="grab" />
        <header><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="Cerrar"><Icon name="close" /></button></header>
        {children}
      </div>
    </div>
  );
}

// ---------- Confirmación de acciones destructivas ----------
let confirmResolver: ((v: boolean) => void) | null = null;
let confirmState: { msg: string; label: string } | null = null;
const csubs = new Set<() => void>();
export function confirmDialog(msg: string, label = 'Confirmar'): Promise<boolean> {
  confirmState = { msg, label }; csubs.forEach((f) => f());
  return new Promise((res) => { confirmResolver = res; });
}
export function ConfirmHost() {
  const s = useSyncExternalStore((f) => { csubs.add(f); return () => csubs.delete(f); }, () => confirmState);
  if (!s) return null;
  const done = (v: boolean) => { confirmState = null; csubs.forEach((f) => f()); confirmResolver?.(v); };
  return (
    <Sheet title="¿Seguro?" onClose={() => done(false)}>
      <p style={{ marginTop: 0 }}>{s.msg}</p>
      <div className="row"><button className="btn grow" onClick={() => done(false)}>Cancelar</button><button className="btn danger grow" onClick={() => done(true)}>{s.label}</button></div>
    </Sheet>
  );
}

// ---------- Piezas pequeñas ----------
export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) { return <div className="skel" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />; }
export function LoadingBlock({ rows = 3 }: { rows?: number }) { return <div className="stack" aria-busy="true" aria-label="Cargando">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={i === 0 ? 28 : 16} w={i === 0 ? '55%' : '100%'} />)}</div>; }
export function ErrorBlock({ error, retry }: { error: Error; retry?: () => void }) {
  return <div className="alert critical" role="alert"><Icon name="warn" /><div className="grow"><b>No se pudo cargar</b><div className="small">{error.message}</div></div>{retry && <button className="btn sm" onClick={retry}>Reintentar</button>}</div>;
}
export function Empty({ icon = 'spark', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={54} /><h3>{title}</h3>{text && <p style={{ margin: '0 0 12px' }}>{text}</p>}{action}</div>;
}
export function Progress({ pct, tone }: { pct: number; tone?: 'warn' | 'danger' }) {
  const t = tone ?? (pct >= 100 ? 'danger' : pct >= 75 ? 'warn' : undefined);
  return <div className={`bar ${t ?? ''}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} /></div>;
}

export function Field({ label, error, hint, children, id }: { label: string; error?: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="err" id={`${id}-err`} role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
export function Switch({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return <label className="switch"><span>{label}{hint && <div className="hint">{hint}</div>}</span><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}

/** Ejecuta una acción async con estado de carga y errores como toast; devuelve [run, busy]. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok, 'ok'); invalidate(); return r; }
    catch (e) { toastError(e); return undefined; }
    finally { setBusy(false); }
  }, []);
  return [run, busy] as const;
}
