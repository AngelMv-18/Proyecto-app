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
Hecho: pruebas de servidor, pruebas de interfaz Playwright (móvil/escritorio), `docs/SEGURIDAD.md`, respaldo/restauración, Dockerfile y docker-compose.

## Fase 8 — Endurecimiento (2FA, multimoneda, limitador persistente)
Hecho:
- **2FA TOTP** con QR, códigos de recuperación y paso de verificación en el acceso (`server/src/services/totp.ts`, `routes/auth.ts`, `web/src/App.tsx`, `screens/Profile.tsx`). Probado con los vectores oficiales del RFC 6238.
- **Multimoneda con tipo de cambio manual**: las cuentas en otra moneda se suman a saldo y patrimonio solo si defines su tipo de cambio, y se marcan como estimación (`fx_rates`, `/api/fx`, Perfil → Tipos de cambio). Ingresos/gastos siguen contando solo la moneda principal.
- **Limitador de intentos persistente** en PostgreSQL (`rate_limits`), usado en acceso, sincronización de Gmail e ingesta.
- Dependencias actualizadas (`@fastify/static` 10, Vite 8, Vitest 5): `npm audit` → 0 vulnerabilidades.
- Arreglo de diseño: desborde horizontal en móvil (columnas de grid sin `minmax(0,…)`), detectado por las pruebas de interfaz.
- El indicador de salud ya no muestra 100/100 sin historial (“Sin datos suficientes” con menos de 7 días).
Archivos: `server/migrations/002_2fa_fx.sql`, `server/src/services/totp.ts`, `server/src/security.ts`, `server/src/routes/{auth,finance,integrations,data}.ts`, `server/src/services/{stats,insights,reports}.ts`, `server/test/phase8.test.ts`, `web/src/{App.tsx,styles.css}`, `web/src/screens/{Profile,Home}.tsx`, `web/e2e/app.spec.ts`.
Cómo probar: `npm test` (52 pruebas) y `npm run test:e2e`. En la app: Perfil → Seguridad → Verificación en dos pasos.

## Lo que falta
- Probar Gmail con credenciales reales y ajustar el parser a los correos/SMS reales de tus bancos.
- Passkeys, notificaciones push, cifrado de disco.
- App Android nativa (opcional) para leer notificaciones sin automatizadores.
- Tipos de cambio automáticos (hoy son manuales) y conversión de ingresos/gastos en otra moneda.
- Intereses de deudas calculados automáticamente (hoy informativos).
- Revisión visual en dispositivos reales Android/iOS.

## Costes externos potenciales
Hosting (VPS ~5–10 USD/mes o PaaS) · dominio + HTTPS (Let's Encrypt gratis) · API de Anthropic solo si activas el modo LLM · evaluación de seguridad de Google solo si publicas la app de Gmail a terceros.
