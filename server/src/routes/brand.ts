import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { parse, uid } from '../http.js';
import { audit } from '../audit.js';
import { isAdmin as isAdminUser } from '../services/users.js';

// Apariencia de la INSTALACIÓN (es una app personal): la define el administrador (el primer usuario creado)
// y se ve también antes de iniciar sesión (pantalla de acceso, nombre e ícono al instalar en el teléfono).
export const DEFAULT_BRAND = { app_name: 'NOVA FINANCE', short_name: 'NOVA', accent: '#C6FF3D', background: 'graphite', logo_version: 0 };
export const BACKGROUNDS = ['graphite', 'midnight', 'oled', 'plum', 'forest'] as const;
const BG_HEX: Record<string, string> = { graphite: '#0B0D10', midnight: '#070B18', oled: '#000000', plum: '#0E0A16', forest: '#07110D' };

export async function getBrand() {
  const r = await one<{ value: any }>(pool, `SELECT value FROM instance_settings WHERE key='brand'`);
  return { ...DEFAULT_BRAND, ...(r?.value ?? {}) };
}
export const appName = async () => (await getBrand()).app_name;

const isAdmin = (userId: string) => isAdminUser(pool, userId);

const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist');
function defaultIcon(size: '192' | '512') {
  const f = join(webDist, `icon-${size}.png`);
  return existsSync(f) ? readFileSync(f) : null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function decodePng(b64: string, maxBytes: number) {
  const buf = Buffer.from(b64.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buf.length < 100 || buf.length > maxBytes || !buf.subarray(0, 8).equals(PNG_SIG)) throw badRequest('El logotipo debe ser una imagen PNG válida', 'invalid_logo');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return { buf, w, h };
}

export async function brandRoutes(app: FastifyInstance) {
  app.get('/api/appearance', async (req) => {
    const b = await getBrand();
    const has = await one(pool, `SELECT 1 FROM brand_assets WHERE name='icon-192'`);
    return { ...b, has_logo: Boolean(has), is_admin: req.userId ? await isAdmin(req.userId) : false };
  });

  app.put('/api/appearance', async (req) => {
    if (!(await isAdmin(uid(req)))) throw new AppError(403, 'forbidden', 'Solo el administrador de esta instalación puede cambiar la apariencia');
    const b = parse(z.object({
      app_name: z.string().trim().min(1).max(30), short_name: z.string().trim().min(1).max(12).optional(),
      accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/), background: z.enum(BACKGROUNDS),
    }), req.body);
    const cur = await getBrand();
    const value = { ...cur, ...b, short_name: b.short_name ?? b.app_name.split(/\s+/)[0].slice(0, 12) };
    await pool.query(`INSERT INTO instance_settings(key,value) VALUES ('brand',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify(value)]);
    await audit(pool, uid(req), 'appearance', null, 'update', null, { app_name: value.app_name, accent: value.accent, background: value.background });
    return value;
  });

  // El navegador recorta y redimensiona la imagen a 192 y 512 px; aquí solo se aceptan PNG cuadrados de esos tamaños.
  app.put('/api/appearance/logo', async (req) => {
    if (!(await isAdmin(uid(req)))) throw new AppError(403, 'forbidden', 'Solo el administrador puede cambiar el logotipo');
    const b = parse(z.object({ png192: z.string().max(400_000), png512: z.string().max(1_400_000) }), req.body);
    const s = decodePng(b.png192, 300_000), l = decodePng(b.png512, 1_000_000);
    if (s.w !== 192 || s.h !== 192 || l.w !== 512 || l.h !== 512) throw badRequest('Tamaños de logotipo inválidos (se esperan 192×192 y 512×512)', 'invalid_logo');
    for (const [name, buf] of [['icon-192', s.buf], ['icon-512', l.buf]] as const) {
      await pool.query(`INSERT INTO brand_assets(name,mime,data) VALUES ($1,'image/png',$2) ON CONFLICT (name) DO UPDATE SET data=$2, updated_at=now()`, [name, buf]);
    }
    const cur = await getBrand();
    const value = { ...cur, logo_version: (cur.logo_version ?? 0) + 1 };
    await pool.query(`INSERT INTO instance_settings(key,value) VALUES ('brand',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify(value)]);
    await audit(pool, uid(req), 'appearance', null, 'logo_updated');
    return { ok: true, logo_version: value.logo_version };
  });

  app.delete('/api/appearance/logo', async (req) => {
    if (!(await isAdmin(uid(req)))) throw new AppError(403, 'forbidden', 'Solo el administrador puede cambiar el logotipo');
    await pool.query('DELETE FROM brand_assets');
    const cur = await getBrand();
    await pool.query(`INSERT INTO instance_settings(key,value) VALUES ('brand',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify({ ...cur, logo_version: (cur.logo_version ?? 0) + 1 })]);
    return { ok: true };
  });

  app.delete('/api/appearance', async (req) => {
    if (!(await isAdmin(uid(req)))) throw new AppError(403, 'forbidden', 'Solo el administrador puede cambiar la apariencia');
    await pool.query(`DELETE FROM instance_settings WHERE key='brand'`);
    await pool.query('DELETE FROM brand_assets');
    return DEFAULT_BRAND;
  });

  // Ícono público (lo descarga Android al instalar la app, sin cookies).
  for (const size of ['192', '512'] as const) {
    app.get(`/brand/icon-${size}.png`, async (_req, reply) => {
      const r = await one<{ data: Buffer }>(pool, 'SELECT data FROM brand_assets WHERE name=$1', [`icon-${size}`]);
      const data = r?.data ?? defaultIcon(size);
      if (!data) throw new AppError(404, 'not_found', 'Ícono no disponible');
      reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=300');
      return reply.send(data);
    });
  }

  // Manifiesto dinámico: nombre, colores e ícono según la apariencia elegida.
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const b = await getBrand();
    const bg = BG_HEX[b.background] ?? BG_HEX.graphite;
    reply.header('content-type', 'application/manifest+json').header('cache-control', 'no-cache');
    return {
      name: b.app_name, short_name: b.short_name, description: 'Tu centro personal de inteligencia financiera', lang: 'es',
      start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait-primary', background_color: bg, theme_color: bg,
      icons: [
        { src: `/brand/icon-192.png?v=${b.logo_version}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/brand/icon-512.png?v=${b.logo_version}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/brand/icon-512.png?v=${b.logo_version}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [{ name: 'Agregar gasto', url: '/#/movimientos?nuevo=gasto' }, { name: 'Preguntar a la IA', url: '/#/ia' }],
    };
  });
}
