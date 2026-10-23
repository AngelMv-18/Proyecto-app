# Seguridad: lo que está implementado (y lo que no)

## Implementado y probado
- **Contraseñas**: scrypt (N=2¹⁵) con sal; mínimo 10 caracteres.
- **Sesiones**: token aleatorio en cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción; en BD solo se guarda su hash SHA-256; caducan (14 días); cambiar contraseña cierra las demás sesiones.
- **Autorización en servidor**: todas las consultas filtran por `user_id` y los identificadores ajenos devuelven 404. Prueba automática de aislamiento entre usuarios (movimientos, metas, deudas, cuentas, búsqueda, exportación).
- **CSRF**: las mutaciones exigen la cabecera `X-Requested-With: nova` y un `Origin` coherente.
- **Límite de intentos** de acceso (8 por 15 min por IP+correo) y mensaje idéntico para correo inexistente o clave errónea.
- **Validación** de entradas con Zod + restricciones `CHECK` en la base de datos.
- **Cabeceras**: CSP estricta (solo `self`), HSTS en producción, `nosniff`, sin framing.
- **Secretos** solo por variables de entorno; tokens OAuth de Google **cifrados en reposo** (AES-256-GCM) con `APP_ENCRYPTION_KEY`; nunca llegan al navegador.
- **Registros técnicos** sin cuerpos, cookies, query strings ni importes. La auditoría guarda cambios financieros del propio usuario, sin secretos.
- **Integridad**: operaciones atómicas, nada de borrado silencioso de movimientos confirmados, historial de cambios.
- **Datos del usuario**: exportación JSON/CSV, restauración atómica, borrado de datos y de cuenta con contraseña + frase de confirmación.
- **Hojas de cálculo**: los CSV neutralizan inyección de fórmulas.
- **Service worker** no guarda respuestas de `/api` en caché.
- **IA**: herramientas de solo lectura acotadas al usuario; en modo LLM solo se envían resultados agregados a la API de Anthropic y se avisa en pantalla.

## Pendiente / limitaciones (sé honesto contigo mismo)
- Sin **2FA/passkeys** todavía.
- La base de datos **no está cifrada en disco** por la app (usa cifrado de disco/volumen en tu hosting).
- El limitador de intentos es **en memoria** (un solo proceso); con varias réplicas hay que moverlo a Redis/BD.
- **HTTPS** lo aporta tu despliegue (proxy); la app no lo termina.
- Los comprobantes se guardan en la base de datos (≤3 MB cada uno) sin análisis antivirus.
- Sin notificaciones push (las alertas son dentro de la app).
- No se ha hecho una auditoría de seguridad externa.
