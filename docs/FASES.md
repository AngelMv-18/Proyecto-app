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

## Fase 9 — Resúmenes periódicos y notificaciones push
Hecho:
- **Resúmenes diario, semanal y mensual** calculados con movimientos confirmados: ingresos, gastos, neto, comparación con el período anterior, categoría principal, gastos más grandes, presupuestos al límite, pagos de los próximos 7 días y aviso de movimientos sin revisar (`services/digest.ts`, `GET /api/digests/:period`, Informes → Resúmenes, con navegación a períodos anteriores).
- **Programador en el servidor** cada 10 min: refresca alertas de todos los usuarios y genera los resúmenes según la hora local (diario 20:00, semanal domingo 19:00, mensual día 1 08:00, configurables). Usa un candado de PostgreSQL para que solo una réplica lo ejecute, y cada resumen se crea una sola vez (`services/scheduler.ts`).
- **Notificaciones push Web Push (VAPID)**: suscripción por dispositivo, prueba, **modo privado por defecto** (la pantalla de bloqueo no muestra importes ni comercios), umbral de severidad, borrado automático de suscripciones caducadas; el service worker muestra la notificación y abre la pantalla correcta (`services/push.ts`, `routes/notify.ts`, `public/sw.js`, Perfil → Notificaciones y resúmenes).
- Si faltan las claves VAPID la app lo dice y sigue mostrando alertas y resúmenes dentro de la app.
Archivos: `server/migrations/003_push_digests.sql`, `server/src/services/{digest,push,scheduler}.ts`, `server/src/routes/notify.ts`, `server/src/{config,index,app}.ts`, `server/test/phase9.test.ts`, `web/public/sw.js`, `web/src/screens/{Profile,Reports}.tsx`, `web/e2e/app.spec.ts`.
Cómo probar: `npm test` (57 pruebas). Para push real: `npx web-push generate-vapid-keys`, define `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, sirve la app por **HTTPS**, instálala en Chrome Android y pulsa “Activar en este dispositivo” → “Probar”.
Limitación: el envío push real pasa por el servicio de Google (FCM) para Chrome Android; no se pudo probar extremo a extremo desde este entorno (se probó con un emisor simulado). iOS solo lo admite con la app instalada en la pantalla de inicio (iOS 16.4+).
Coste: gratis (Web Push no cobra por mensaje).

## Lo que falta
- Probar Gmail con credenciales reales y ajustar el parser a los correos/SMS reales de tus bancos.
- Passkeys y cifrado de disco.
- Probar el envío push real en un teléfono (requiere HTTPS y claves VAPID).
- App Android nativa (opcional) para leer notificaciones sin automatizadores.
- Tipos de cambio automáticos (hoy son manuales) y conversión de ingresos/gastos en otra moneda.
- Intereses de deudas calculados automáticamente (hoy informativos).
- Revisión visual en dispositivos reales Android/iOS.

## Costes externos potenciales
Hosting (VPS ~5–10 USD/mes o PaaS) · dominio + HTTPS (Let's Encrypt gratis) · API de Anthropic solo si activas el modo LLM · evaluación de seguridad de Google solo si publicas la app de Gmail a terceros.
