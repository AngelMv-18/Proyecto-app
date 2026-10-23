import { SVGProps } from 'react';

const P: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  pie: 'M12 3v9h9a9 9 0 1 1-9-9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  spark: 'M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  plus: 'M12 5v14M5 12h14',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  close: 'M6 6l12 12M18 6 6 18',
  arrowUp: 'M12 19V5M5 12l7-7 7 7', arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  swap: 'M7 7h13l-4-4M17 17H4l4 4',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zM17 14h.01',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  scale: 'M12 3v18M5 21h14M6 7h12M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 3 2 20h20zM12 10v5M12 18h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  download: 'M12 3v13M6 11l6 6 6-6M4 21h16',
  upload: 'M12 17V4M6 10l6-6 6 6M4 21h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7',
  utensils: 'M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2.5 1.5-3 4-3 7h3',
  bus: 'M5 4h14v13H5zM5 11h14M8 20v-3M16 20v-3M8 14h.01M16 14h.01',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z', book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  chip: 'M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  ticket: 'M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6H3zM14 6v12',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z', bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  vault: 'M4 4h16v16H4zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 20v1M16 20v1', dots: 'M5 12h.01M12 12h.01M19 12h.01', coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M9.5 9.5c0-1 1.1-1.5 2.5-1.5s2.5.5 2.5 1.7c0 2.3-5 1.3-5 3.6 0 1.1 1.1 1.7 2.5 1.7s2.5-.6 2.5-1.5',
  chevron: 'M9 6l6 6-6 6', logout: 'M10 4H5v16h5M16 8l4 4-4 4M20 12H9', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3', send: 'M4 12l16-8-6 16-3-7z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 8v5l3 2', receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
};

export function Icon({ name, size = 22, ...rest }: { name: string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={P[name] ?? P.dots} />
    </svg>
  );
}

export function Logo({ size = 34, text = true }: { size?: number; text?: boolean }) {
  return (
    <span className="logo" aria-label="NOVA FINANCE">
      <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-hidden="true">
        <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#C6FF3D" /><stop offset="1" stopColor="#2DE2D0" /></linearGradient></defs>
        <rect width="48" height="48" rx="14" fill="#0E1217" stroke="rgba(255,255,255,.12)" />
        <path d="M13 35V13l22 22V13" stroke="url(#lg)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M38 4l1.4 4 4 1.4-4 1.4L38 14.8l-1.4-4-4-1.4 4-1.4z" fill="#C6FF3D" />
      </svg>
      {text && <span>NOVA<span style={{ color: 'var(--lime)' }}> FINANCE</span></span>}
    </span>
  );
}

export const catIcon = (icon?: string | null) => icon ?? 'dots';
