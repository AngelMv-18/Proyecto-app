# Seguridad: lo que está implementado (y lo que no)

## Implementado y probado
- **Contraseñas**: scrypt (N=2¹⁵) con sal; mínimo 10 caracteres.
- **Sesiones**: token aleatorio en cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción; en BD solo se guarda su hash SHA-256; caducan (14 días); cambiar contraseña cierra las demás sesiones.
- **Autorización en servidor**: todas las consultas filtran por `user_id` y los identificadores ajenos devuelven 404. Prueba automática de aislamiento entre usuarios (movimientos, metas, deudas, cuentas, búsqueda, exportación).
- **CSRF**: las mutaciones exigen la cabecera `X-Requested-With: nova` y un `Origin` coherente.
- **Verificación en dos pasos (TOTP, RFC 6238)** opcional: QR para la app de autenticación, tolerancia ±30 s, un código no se puede reutilizar, 8 códigos de recuperación de un solo uso (guardados con hash), desactivación con contraseña + código. El inicio de sesión con 2FA usa un ticket de un solo uso (5 min, máx. 5 intentos) y no crea sesión hasta validar el código. El secreto se cifra con `APP_ENCRYPTION_KEY` si está definida (si no, la interfaz lo advierte).
- **Límite de intentos persistente** en PostgreSQL (8 por 15 min por IP+correo; también en sincronización de Gmail e ingesta): funciona con varias réplicas y sobrevive a reinicios. Mensaje idéntico para correo inexistente o clave errónea.
- **Validación** de entradas con Zod + restricciones `CHECK` en la base de datos.
- **Cabeceras**: CSP estricta (solo `self`), HSTS en producción, `nosniff`, sin framing.
- **Secretos** solo por variables de entorno; tokens OAuth de Google **cifrados en reposo** (AES-256-GCM) con `APP_ENCRYPTION_KEY`; nunca llegan al navegador.
- **Registros técnicos** sin cuerpos, cookies, query strings ni importes. La auditoría guarda cambios financieros del propio usuario, sin secretos.
- **Integridad**: operaciones atómicas, nada de borrado silencioso de movimientos confirmados, historial de cambios.
- **Datos del usuario**: exportación JSON/CSV, restauración atómica, borrado de datos y de cuenta con contraseña + frase de confirmación.
- **Hojas de cálculo**: los CSV neutralizan inyección de fórmulas.
- **Service worker** no guarda respuestas de `/api` en caché.
- **IA**: herramientas de solo lectura acotadas al usuario; en modo LLM solo se envían resultados agregados a la API de Anthropic y se avisa en pantalla.

- **Dependencias**: `npm audit` sin vulnerabilidades conocidas a la fecha de esta fase (se actualizó `@fastify/static` por avisos de recorrido de rutas).

## Pendiente / limitaciones (sé honesto contigo mismo)
- Sin **passkeys/WebAuthn** todavía (la 2FA es por código TOTP).
- La base de datos **no está cifrada en disco** por la app (usa cifrado de disco/volumen en tu hosting).
- **HTTPS** lo aporta tu despliegue (proxy); la app no lo termina.
- Los comprobantes se guardan en la base de datos (≤3 MB cada uno) sin análisis antivirus.
- Las notificaciones push pasan por el servicio push del navegador (Google FCM en Chrome); en **modo privado** (por defecto) no llevan importes ni comercios. El contenido de Web Push va cifrado extremo a extremo (RFC 8291).
- No se ha hecho una auditoría de seguridad externa.
