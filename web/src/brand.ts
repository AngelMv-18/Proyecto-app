import { useSyncExternalStore } from 'react';

export type Brand = { app_name: string; short_name: string; accent: string; background: string; has_logo: boolean; logo_version: number; is_admin: boolean };
export const DEFAULT_BRAND: Brand = { app_name: 'NOVA FINANCE', short_name: 'NOVA', accent: '#C6FF3D', background: 'graphite', has_logo: false, logo_version: 0, is_admin: false };
export const BG_OPTIONS: { id: string; name: string; color: string }[] = [
  { id: 'graphite', name: 'Grafito', color: '#0B0D10' }, { id: 'midnight', name: 'Medianoche', color: '#070B18' },
  { id: 'oled', name: 'Negro puro', color: '#000000' }, { id: 'plum', name: 'Ciruela', color: '#0E0A16' }, { id: 'forest', name: 'Bosque', color: '#07110D' },
];
export const ACCENTS = [['Lima', '#C6FF3D'], ['Turquesa', '#2DE2D0'], ['Violeta', '#8B7BFF'], ['Ámbar', '#FFB84D'], ['Rosa', '#FF6BB5'], ['Azul', '#4DA3FF'], ['Coral', '#FF7A59'], ['Plata', '#E8ECF1']];

let brand: Brand = DEFAULT_BRAND;
const subs = new Set<() => void>();

/** Texto legible sobre el acento: negro o blanco según su luminancia. */
function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * L(r) + 0.7152 * L(g) + 0.0722 * L(b) > 0.35 ? '#0B0D10' : '#FFFFFF';
}

export function applyBrand(b: Partial<Brand>) {
  brand = { ...brand, ...b };
  const root = document.documentElement;
  root.style.setProperty('--lime', brand.accent);
  root.style.setProperty('--on-lime', onColor(brand.accent));
  if (brand.background === 'graphite') root.removeAttribute('data-bg'); else root.setAttribute('data-bg', brand.background);
  const bg = BG_OPTIONS.find((o) => o.id === brand.background)?.color ?? '#0B0D10';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  document.title = brand.app_name;
  subs.forEach((f) => f());
}
export async function loadBrand() {
  try { const r = await fetch('/api/appearance', { credentials: 'same-origin' }); if (r.ok) applyBrand(await r.json()); } catch { /* se usa la apariencia por defecto */ }
}
export const useBrand = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => brand);
