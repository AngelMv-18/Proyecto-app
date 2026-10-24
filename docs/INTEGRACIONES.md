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
| **C. Notificaciones/SMS del banco** | 🟡 Endpoint listo y probado; **app Android NOVA Captura** escrita, con lógica probada, compilación verificada contra el framework y APK generado por GitHub Actions; **sin probar en un teléfono real** | Instalar el APK (orígenes desconocidos), conceder *Acceso a notificaciones* y, si quieres SMS, el permiso *Recibir SMS*; marcar las apps/remitentes de tus bancos. Alternativa: Tasker/MacroDroid. Una PWA **no puede** leer notificaciones. | Gratis |
| **D. Extractos CSV/OFX** | ✅ Funciona | Descargar el extracto de tu banca en línea. Detecta columnas y separadores; fechas día/mes/año; débitos/créditos o importe con signo. Re-importar el mismo archivo no duplica. Formatos de bancos concretos no verificados: el mapeo es editable. | Gratis |
| **E. Otras** | — | Comprobantes: foto adjunta manual. Billeteras (Tigo Money, etc.): igual que C/D si avisan por SMS/correo. | — |

## Gmail: flujo de un solo botón
1. El administrador activa la conexión **una vez** (asistente en *Integraciones* con los URI de redirección listos para copiar y enlaces a Google Cloud). Los demás usuarios no ven pasos técnicos.
2. Cada usuario pulsa **«Vincular mi Gmail»** → pantalla oficial de Google → acepta el permiso de solo lectura.
3. Al volver, NOVA elige sola la cuenta destino (moneda base primero; débito, banco, crédito, billetera), hace la primera revisión en segundo plano y luego **revisa sola cada hora** (programador del servidor). Todo llega a *Revisión*; nada afecta saldos sin confirmar.
4. La cuenta destino se cambia con un selector; remitentes y etiqueta son filtros **opcionales** en «Opciones avanzadas».

## Gmail: qué correos se leen y cómo se asignan
- Búsqueda: remitentes y asuntos típicos de bancos y billeteras de Honduras (BAC, Atlántida, Ficohsa, Banpaís, Occidente, Davivienda, LAFISE, Banrural, Promerica, Azteca, Cuscatlán, Tigo Money, TENGO…), **sin** Promociones ni Redes sociales. Primera revisión: 30 días (hasta 150 correos); después, solo lo nuevo.
- Formatos reconocidos y probados con la estructura real de los avisos de **BAC Credomatic**: tarjeta («MASTERCARD 2001», tabla Comercio / Monto / Horario) y cuenta («cuenta en LPS, número *****6480», Fecha / Monto enviado). Para otros bancos se usa el lector general; conviene enviar ejemplos reales para ajustarlo.
- Cada aviso va a la cuenta o tarjeta con los **mismos últimos 4 dígitos**; si no hay, a la única de ese banco en esa moneda; si no, a la cuenta destino elegida. Lo anterior a la fecha de saldo inicial de la cuenta no se registra (ya está incluido en ese saldo).

## Gmail: recibos de compras en línea y cuándo la app pregunta
- Además de los avisos de bancos, se leen **recibos** de Google Play, PayPal, Apple, Netflix, Spotify y Uber. Del recibo salen el comercio («Supercell (Google Play)»), el artículo, el número de pedido, la fecha y la **forma de pago** («Bac débito Angel»), que sirve para elegir la tarjeta.
- Si el cobro es en **otra moneda** (p. ej. USD 1.99 en una cuenta en lempiras) se registra convertido con tu tipo de cambio de Perfil o, si no hay, con uno de referencia aproximado (USD ≈ 26.5). Queda *por revisar* con un aviso «importe estimado»: corrígelo con el monto real que cobró tu banco (al corregirlo el aviso desaparece).
- La cuenta se elige por: últimos 4 dígitos → forma de pago del recibo (nombre de la tarjeta, o banco + débito/crédito) → banco si todo es el mismo dinero (tarjeta de débito vinculada a su cuenta). Si no hay coincidencia clara y tienes más de un lugar posible, el movimiento queda **«¿De qué tarjeta o cuenta es?»** en Revisión: no se puede confirmar (ni con «Confirmar todos») hasta elegirla.

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

## App Android “NOVA Captura” (carpeta `android/`)
- **Qué lee**: solo el texto visible de notificaciones de las apps que marques (`NotificationListenerService`, requiere que actives *Acceso a notificaciones*) y, opcionalmente, SMS de remitentes que escribas (`RECEIVE_SMS`, permiso en tiempo de ejecución). No lee datos internos de otras apps, no usa accesibilidad ni intercepta comunicaciones.
- **Qué descarta en el teléfono**: orígenes no autorizados, códigos de seguridad/OTP/claves, textos sin importe y avisos repetidos (las apps bancarias re-publican la misma notificación).
- **Envío**: HTTPS obligatorio a `POST /api/ingest/notification` con el token de ingesta (guardado cifrado con el Android Keystore). Cola local con reintentos exponenciales (hasta 2 días) si no hay internet; cada aviso lleva un `source_id` estable para que el servidor no lo duplique al reintentar.
- **En el servidor** todo entra como *pendiente de revisión*, con origen “Notificación: Banco X” o “SMS: remitente”.
- **Google Play**: el permiso de SMS es *restringido* en Play y el acceso a notificaciones exige declarar el uso; para uso personal se instala directamente el APK (*sideload*), sin publicar.
- **Compilar**: GitHub Actions (`.github/workflows/android.yml`) genera el APK como artefacto descargable. Localmente: `cd android && gradle :app:assembleRelease` con el SDK de Android instalado. Sin SDK: `gradle :core:test` (lógica) y `android/tools/compile-check` (compila las fuentes contra el framework de Android API 35 de Robolectric).
