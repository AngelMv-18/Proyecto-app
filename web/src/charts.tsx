import { useId, useMemo, useState } from 'react';
import { money } from './format';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Área/línea suave del saldo, sin dependencias. */
export function AreaChart({ data, height = 120, color = 'var(--lime)', label, showAxis = false, fmt = (v: number) => money(v, undefined, { compact: true }) }: { data: { x: string; y: number }[]; height?: number; color?: string; label: string; showAxis?: boolean; fmt?: (v: number) => string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 400;
  const { path, area, pts, min, max } = useMemo(() => {
    if (data.length < 2) return { path: '', area: '', pts: [] as [number, number][], min: 0, max: 0 };
    const ys = data.map((d) => d.y);
    const mn = Math.min(...ys), mx = Math.max(...ys);
    const span = mx - mn || 1, pad = height * 0.12;
    const p = data.map((d, i) => [lerp(0, W, i / (data.length - 1)), height - pad - ((d.y - mn) / span) * (height - pad * 2)] as [number, number]);
    const line = p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return { path: line, area: `${line} L${W},${height} L0,${height} Z`, pts: p, min: mn, max: mx };
  }, [data, height]);
  if (data.length < 2) return <div className="muted small" style={{ height, display: 'grid', placeItems: 'center' }}>Aún no hay suficientes datos para graficar.</div>;
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (data.length - 1)));
  };
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={label} onPointerMove={move} onPointerLeave={() => setHover(null)} style={{ display: 'block', touchAction: 'pan-y' }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".38" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover != null && <g><line x1={pts[hover][0]} x2={pts[hover][0]} y1="0" y2={height} stroke="rgba(255,255,255,.25)" vectorEffect="non-scaling-stroke" /><circle cx={pts[hover][0]} cy={pts[hover][1]} r="4.5" fill={color} stroke="#0B0D10" strokeWidth="2" vectorEffect="non-scaling-stroke" /></g>}
      </svg>
      {hover != null && <div className="xs" style={{ position: 'absolute', top: 0, left: `${(hover / (data.length - 1)) * 100}%`, transform: `translateX(${hover > data.length * 0.7 ? '-100%' : '0'})`, background: 'var(--surface3)', border: '1px solid var(--line2)', padding: '3px 8px', borderRadius: 8, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{data[hover].x} · <b>{fmt(data[hover].y)}</b></div>}
      {showAxis && <div className="row between xs faint" style={{ marginTop: 4 }}><span>{data[0].x}</span><span>mín {fmt(min)} · máx {fmt(max)}</span><span>{data[data.length - 1].x}</span></div>}
    </div>
  );
}

/** Barras agrupadas (ingresos vs gastos). */
export function Bars({ data, series, height = 150, label }: { data: { label: string; values: number[] }[]; series: { name: string; color: string }[]; height?: number; label: string }) {
  const max = Math.max(1, ...data.flatMap((d) => d.values.map(Math.abs)));
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div>
      <div role="img" aria-label={label} style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height, borderBottom: '1px solid var(--line)' }}>
        {data.map((d, i) => (
          <button key={d.label} onClick={() => setSel(sel === i ? null : i)} aria-label={`${d.label}: ${d.values.map((v, k) => `${series[k].name} ${money(v)}`).join(', ')}`} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 3, background: sel === i ? 'rgba(255,255,255,.04)' : 'none', border: 0, borderRadius: 8, cursor: 'pointer', padding: 0 }}>
            {d.values.map((v, k) => <i key={k} style={{ width: `${Math.max(100 / (d.values.length + 1), 8)}%`, maxWidth: 22, height: `${Math.max((Math.abs(v) / max) * 100, v ? 2 : 0)}%`, background: series[k].color, borderRadius: '6px 6px 2px 2px', transition: 'height .7s cubic-bezier(.2,.8,.2,1)' }} />)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>{data.map((d) => <span key={d.label} className="xs faint" style={{ flex: 1, textAlign: 'center' }}>{d.label}</span>)}</div>
      <div className="legend" style={{ marginTop: 8 }}>{series.map((s) => <span key={s.name}><i className="dotc" style={{ background: s.color, marginRight: 6 }} />{s.name}</span>)}</div>
      {sel != null && <div className="small" style={{ marginTop: 8 }}><b>{data[sel].label}</b> — {data[sel].values.map((v, k) => `${series[k].name}: ${money(v)}`).join(' · ')}</div>}
    </div>
  );
}

export const PALETTE = ['#C6FF3D', '#2DE2D0', '#8B7BFF', '#FFB84D', '#FF6B7A', '#5BE38A', '#6CB7FF', '#F58BDC'];

/** Dona de categorías con leyenda accesible. */
export function Donut({ data, size = 170, centerLabel }: { data: { name: string; value: number }[]; size?: number; centerLabel?: string }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = 62, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox="0 0 160 160" role="img" aria-label={`Gastos por categoría, total ${money(total)}`}>
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--surface3)" strokeWidth="16" />
        {total > 0 && data.map((d, i) => {
          const len = (d.value / total) * c;
          const el = <circle key={d.name} cx="80" cy="80" r={r} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="16" strokeDasharray={`${Math.max(len - 2, 0)} ${c}`} strokeDashoffset={-acc} transform="rotate(-90 80 80)" style={{ transition: 'stroke-dasharray .8s' }} />;
          acc += len; return el;
        })}
        <text x="80" y="76" textAnchor="middle" fill="var(--muted)" fontSize="9">{centerLabel ?? 'Gasto del período'}</text>
        <text x="80" y="95" textAnchor="middle" fill="var(--text)" fontSize="15" fontWeight="700" fontFamily="var(--display)">{money(total, undefined, { compact: true })}</text>
      </svg>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: 1, minWidth: 150, display: 'grid', gap: 7 }}>
        {data.slice(0, 7).map((d, i) => (
          <li key={d.name} className="row small"><i className="dotc" style={{ background: PALETTE[i % PALETTE.length] }} /><span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span><b className="num">{money(d.value)}</b><span className="faint xs" style={{ width: 34, textAlign: 'right' }}>{total ? Math.round((d.value / total) * 100) : 0}%</span></li>
        ))}
      </ul>
    </div>
  );
}

/** Indicador semicircular de salud financiera. */
export function Gauge({ score, label }: { score: number | null; label: string }) {
  const r = 52, c = Math.PI * r;
  const v = score ?? 0;
  const color = score == null ? 'var(--faint)' : v >= 75 ? 'var(--ok)' : v >= 50 ? 'var(--lime)' : v >= 30 ? 'var(--warn)' : 'var(--danger)';
  return (
    <svg width="150" height="92" viewBox="0 0 130 80" role="img" aria-label={score == null ? 'Salud financiera sin datos' : `Salud financiera ${score} de 100, ${label}`}>
      <path d="M13 70a52 52 0 0 1 104 0" fill="none" stroke="var(--surface3)" strokeWidth="11" strokeLinecap="round" />
      <path d="M13 70a52 52 0 0 1 104 0" fill="none" stroke={color} strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: 'stroke-dasharray 1s cubic-bezier(.2,.8,.2,1)', filter: `drop-shadow(0 0 6px ${color})` }} />
      <text x="65" y="60" textAnchor="middle" fill="var(--text)" fontSize="26" fontWeight="700" fontFamily="var(--display)">{score ?? '—'}</text>
      <text x="65" y="76" textAnchor="middle" fill="var(--muted)" fontSize="9.5">{label}</text>
    </svg>
  );
}

export function Ring({ pct, size = 64, children }: { pct: number; size?: number; children?: React.ReactNode }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }} role="img" aria-label={`${Math.round(pct)}% completado`}>
      <svg width={size} height={size} viewBox="0 0 64 64"><circle cx="32" cy="32" r={r} fill="none" stroke="var(--surface3)" strokeWidth="6" /><circle cx="32" cy="32" r={r} fill="none" stroke="url(#ringg)" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(Math.min(pct, 100) / 100) * c} ${c}`} transform="rotate(-90 32 32)" style={{ transition: 'stroke-dasharray .9s' }} /><defs><linearGradient id="ringg"><stop offset="0" stopColor="#2DE2D0" /><stop offset="1" stopColor="#C6FF3D" /></linearGradient></defs></svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: '.78rem', fontWeight: 700 }} className="num">{children ?? `${Math.round(pct)}%`}</div>
    </div>
  );
}
