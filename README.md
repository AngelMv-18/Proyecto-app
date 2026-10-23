# NOVA FINANCE

Centro personal de inteligencia financiera: contabilidad personal consistente, presupuestos, metas, deudas, informes,
asistente **NOVA AI** y detección asistida de movimientos. Interfaz en español, PWA instalable en Android y usable en escritorio.
Moneda por defecto: lempira hondureño (HNL), configurable.

> Estado honesto: el registro manual, la contabilidad, los presupuestos, metas, deudas, recurrencias, informes, importación CSV/OFX,
> la ingesta por automatización y NOVA AI (modo local) **funcionan y están probados**. La integración con Gmail está **implementada pero no
> conectada** hasta que configures credenciales de Google (no se pudo probar contra Google real). No hay API bancaria ni de Google Pay: ver
> [`docs/INTEGRACIONES.md`](docs/INTEGRACIONES.md).

## Arranque rápido (desarrollo)

Requisitos: Node 22+, PostgreSQL 14+.

```bash
npm install
createdb nova_dev   # o ajusta DATABASE_URL
export DATABASE_URL=postgres://usuario:clave@localhost:5432/nova_dev
npm run build                    # compila web + servidor
npm start                        # http://localhost:3000 (aplica migraciones al iniciar)
node scripts/demo.mjs            # OPCIONAL: carga datos de demostración (demo@nova.local / demo-nova-2026)
```

Desarrollo con recarga: `npm run dev:server` y `npm run dev:web` (Vite en :5173 con proxy a :3000).
El primer usuario se crea desde la pantalla de acceso; después el registro se cierra salvo `ALLOW_REGISTRATION=true`.

## Pruebas

```bash
npm test            # 47 pruebas de servidor (PostgreSQL real, base nova_test; usa TEST_DATABASE_URL para cambiarla)
npm run test:e2e    # pruebas de interfaz con Playwright (móvil + escritorio; base nova_e2e)
```

## Despliegue

`docker compose up -d` (ver `docker-compose.yml`, `.env.example`). Pon HTTPS delante: la cookie de sesión es `Secure` en producción.
Respaldos: `scripts/backup.sh` (pg_dump) y, desde la app, Perfil → “Descargar respaldo completo (JSON)” / “Restaurar”.
Coste orientativo: un VPS pequeño (1 GB RAM) o un servicio con PostgreSQL gestionado; sin costes por usuario. NOVA AI con modelo de lenguaje
(opcional) factura por uso de la API de Anthropic.

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md): stack, modelo de datos y reglas contables.
- [`docs/INTEGRACIONES.md`](docs/INTEGRACIONES.md): Google Pay, Gmail, notificaciones, extractos, bancos en Honduras; qué falta para cada una.
- [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md): controles realmente implementados y pendientes.
- [`docs/FASES.md`](docs/FASES.md): resumen por fase, archivos, qué falta y costes.
