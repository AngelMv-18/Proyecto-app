# Arquitectura

## Decisión de stack

| Necesidad | Elección | Por qué |
|---|---|---|
| App móvil + escritorio | **PWA** (React + Vite + TypeScript) | Instalable en Android, una sola base de código, sin tienda. No puede leer notificaciones de otras apps (ver integraciones). |
| API | **Node 22 + Fastify 5 + TypeScript** | Ligero, validación con Zod, un solo proceso sirve API y PWA (despliegue barato). |
| Datos | **PostgreSQL 16** | Transacciones ACID, restricciones `CHECK`, vistas; imprescindible para exactitud financiera. SQLite/localStorage descartados. |
| Gráficos | SVG propio | Cero dependencias, control total del diseño y la accesibilidad. |
| IA | Herramientas de solo lectura + modo local determinista; LLM opcional (API de Anthropic) | Las cifras salen siempre de SQL, nunca del modelo. |

Una app Android nativa (Kotlin) queda como **fase posterior** solo si quieres leer notificaciones/SMS bancarios sin apps de automatización.

## Modelo contable (la parte crítica)

- Importes en **centavos** (`BIGINT`), nunca flotantes. La moneda de cada movimiento es la de su cuenta.
- **No existe saldo almacenado.** `saldo = saldo_inicial + Σ efectos de movimientos confirmados` (vista `v_effects`). Imposible que el saldo se desfase de los movimientos; hay una prueba de propiedad aleatoria que lo verifica.
- Estados: `pending` (detectado/importado, no afecta nada), `confirmed`, `void` (anulado; se conserva con motivo y auditoría). Los confirmados no se borran.
- Tipos y efecto en la cuenta:
  - `income` +, `expense` −, `refund` + (corrige el gasto neto de su categoría), `adjustment` ± (no es ingreso/gasto).
  - `transfer`: − origen, + destino (con `to_amount` si cambia la moneda). **Nunca** es ingreso ni gasto. Pagar una tarjeta = transferencia a la cuenta de tarjeta (saldo negativo = deuda), por eso no duplica gastos.
  - `debt_payment` / `debt_collection`: mueven dinero y reducen el saldo de una deuda; no son gasto/ingreso de consumo. El *origen* de la deuda es un `income`/`expense` ligado a `debt_id`, excluido de los indicadores.
  - `goal_saving`: meta **virtual** = reserva (no cambia saldos; limitada al saldo libre → no crea dinero); meta con **cuenta real** = transferencia a esa cuenta.
- Ingresos/gastos de informes: `income` y `expense` sin `debt_id`, menos reembolsos; en la moneda principal. Otras monedas se listan aparte y se avisa.
- Atomicidad: cada operación (movimiento + auditoría + estado de deuda) va en una transacción SQL.
- Duplicados: `external_id` único por usuario (importes repetidos), y heurística importe+comercio+±36 h entre fuentes (notificación vs correo se **fusionan**; misma fuente repetida se marca para revisión).
- Auditoría: tabla `audit_log` con antes/después de cada cambio, sin secretos.

## Entidades

`users, sessions, accounts, categories (con subcategorías y naturaleza esencial/discrecional/extraordinaria), transactions, receipts, budgets, goals, debts, recurring, imports, reconciliations, integrations, notifications, audit_log`. Esquema en `server/migrations/001_init.sql`; las migraciones se aplican al iniciar (`schema_migrations`).

## Mapa del código

```
server/src
  app.ts, index.ts, config.ts, db.ts, migrate.ts, security.ts, audit.ts, seed.ts
  services/ ledger.ts (reglas contables) · stats.ts (saldos, períodos, presupuestos, metas)
            insights.ts (dashboard, salud, evaluador de compras, sugerencias) · alerts.ts
            parser.ts (correo/notificación) · importer.ts (CSV/OFX) · ingest.ts · gmail.ts
            ai.ts (NOVA AI) · reports.ts
  routes/   auth · finance · insights · integrations · data
web/src     App.tsx, ui.tsx, charts.tsx, icons.tsx, format.ts, styles.css, components/TxForm.tsx, screens/*
```
