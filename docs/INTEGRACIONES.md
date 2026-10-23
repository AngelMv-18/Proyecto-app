# Integraciones: qué es real, qué falta y qué cuesta

Principio: **nada afecta tus saldos sin que lo revises**. Todo movimiento detectado entra como *pendiente* con su origen visible
(Manual / Correo / Notificación / Importado) y pasa por la pantalla **Revisión**. Rechazadas, canceladas y códigos de seguridad se descartan.

## Google Pay / Google Wallet
Google Pay y Wallet **no ofrecen una API pública para que una app lea tus pagos**. Las APIs de Google Pay son para comercios (aceptar pagos) y
la de Wallet para emisores de pases; la "Transaction Events API" va en sentido contrario (comercio → Google). Tampoco se puede deducir un importe
de una conexión NFC. NOVA **no finge** esta integración: las compras con Google Pay se detectan *indirectamente* por los avisos de tu banco
(correo, SMS/notificación) o por el extracto. La app lo muestra en Integraciones.

## Opciones evaluadas

| Método | Estado | Qué falta / requisitos | Coste |
|---|---|---|---|
| **A. API bancaria oficial / agregador** | ❌ No disponible | No encontré (búsqueda web, oct-2026) una API pública verificada para BAC, Banpaís, Ficohsa, etc., ni cobertura confirmada de Plaid/Belvo en Honduras; el directorio Open Banking Tracker lista bancos hondureños sin sandbox ni agregadores. **Verifica directamente** con cada banco, la CNBS y los agregadores. Si algún banco te da acceso, se añade como `source='bank_api'` (el modelo ya lo contempla). | — |
| **B. Gmail (OAuth, solo lectura)** | 🟡 Implementado, **sin probar contra Google real**, desactivado hasta configurar | Proyecto en Google Cloud + Gmail API + pantalla de consentimiento + credenciales web; variables `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ENCRYPTION_KEY`; callback `PUBLIC_URL/api/integrations/gmail/callback` (HTTPS). Que tu banco te envíe avisos por correo. | Gratis para uso propio |
| **C. Notificaciones/SMS del banco** | 🟡 Endpoint listo (`POST /api/ingest/notification`, token por usuario) | Una PWA **no puede** leer notificaciones. Usa una app de automatización instalada por ti (Tasker/MacroDroid) con permiso de acceso a notificaciones/SMS que haga POST al endpoint, o una app Android nativa propia (`NotificationListenerService`) como fase posterior. Los bancos que avisan por SMS son frecuentes en Honduras. | Apps de automatización: gratis/pago bajo |
| **D. Extractos CSV/OFX** | ✅ Funciona | Descargar el extracto de tu banca en línea. Detecta columnas y separadores; fechas día/mes/año; débitos/créditos o importe con signo. Re-importar el mismo archivo no duplica. Formatos de bancos concretos no verificados: el mapeo es editable. | Gratis |
| **E. Otras** | — | Comprobantes: foto adjunta manual. Billeteras (Tigo Money, etc.): igual que C/D si avisan por SMS/correo. | — |

## Gmail: política y límites reales (verifica en la consola de Google, cambia con el tiempo)
- `gmail.readonly` es un alcance **restringido**: para publicar la app a terceros Google exige verificación y, si guardas datos en servidores, una evaluación de seguridad anual de pago. Para **uso personal** puedes dejarla en modo *Pruebas* con tu cuenta como usuario de prueba, pero en ese modo **el refresh token caduca a los 7 días** (hay que reconectar); en producción sin verificar verás una pantalla de advertencia y un tope de usuarios.
- Alternativa sin permisos restringidos: reenviar los avisos a una etiqueta/alias y usar C o D.
- La app solo pide `gmail.readonly` (+ `openid email`), nunca envía ni modifica correos, no guarda el cuerpo (solo importe, comercio, referencia, fecha y un asunto truncado como origen) y permite **desconectar y revocar** el token.

## Interpretación de mensajes
`parser.ts` reconoce importes (`L 1,250.50`, `HNL`, `US$`, `1.234,56`), comercio, referencia, fecha `dd/mm/aaaa`, últimos 4 dígitos, y estado
(aprobada / pendiente en el banco / rechazada-cancelada → ignorada). Es heurístico y está cubierto por pruebas con mensajes *sintéticos*; los
formatos reales de tus bancos pueden requerir ajustes: cuando falle, el movimiento llega a Revisión para que lo corrijas.

## Duplicados
Misma referencia/ID externo → no se vuelve a crear. Misma compra por dos fuentes (notificación + correo) → se **fusiona** y se anota la segunda fuente.
Misma fuente con importe/comercio/fecha iguales → se crea marcada "Posible duplicado" (puede ser una compra repetida real).
