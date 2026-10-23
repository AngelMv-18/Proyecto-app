# Resumen por fase

## Fase 1 — Arquitectura, modelo de datos, diseño
Hecho: `docs/ARQUITECTURA.md`, `server/migrations/001_init.sql`, sistema de diseño (`web/src/styles.css`), logotipo (`icons.tsx`, `public/icon.svg`).
## Fase 2 — Interfaz premium y navegación responsive
Hecho: tema oscuro grafito con acentos lima/turquesa/violeta, navegación inferior (móvil) y lateral (escritorio), hojas inferiores, toasts, estados de carga/vacío/error, búsqueda global (Ctrl+K), PWA (manifest, service worker, íconos). Archivos: `web/src/*`, `web/public/*`.
## Fase 3 — Cuentas, movimientos, saldos
Hecho: 8 tipos de movimiento, formulario rápido, edición, anulación con auditoría, revisión, conciliación, tarjetas de crédito, comprobantes. `server/src/services/ledger.ts`, `routes/finance.ts`.
## Fase 4 — Presupuestos, metas, deudas, recurrencias, informes
Hecho: umbrales 50/75/90/100 %, traspaso entre presupuestos, metas virtuales/reales con estimaciones, deudas con plan orientativo, recurrencias con sugerencias confirmables, 10 informes con calidad de datos, CSV e imprimible.
## Fase 5 — NOVA AI
Hecho: 10 herramientas de solo lectura, modo local determinista, modo LLM opcional, evaluador “¿Me conviene comprarlo?” determinista y explicable.
## Fase 6 — Integraciones
Hecho: importación CSV/OFX, endpoint de ingesta, parser, Gmail OAuth (sin probar contra Google), detección de duplicados. Honestidad sobre banco/Google Pay: `docs/INTEGRACIONES.md`.
## Fase 7 — Pruebas, seguridad, respaldos, despliegue
Hecho: 47 pruebas de servidor, pruebas de interfaz Playwright (móvil/escritorio), `docs/SEGURIDAD.md`, respaldo/restauración, Dockerfile y docker-compose.

## Lo que falta
- Probar Gmail con credenciales reales y ajustar el parser a los correos/SMS reales de tus bancos.
- 2FA, notificaciones push, cifrado de disco, limitador de intentos compartido.
- App Android nativa (opcional) para leer notificaciones sin automatizadores.
- Multimoneda con conversión (hoy cada moneda se reporta aparte; los totales suman solo la principal).
- Intereses de deudas calculados automáticamente (hoy informativos).
- Revisión visual en dispositivos reales Android/iOS.

## Costes externos potenciales
Hosting (VPS ~5–10 USD/mes o PaaS) · dominio + HTTPS (Let's Encrypt gratis) · API de Anthropic solo si activas el modo LLM · evaluación de seguridad de Google solo si publicas la app de Gmail a terceros.
