# Despliegue gratuito: Render (servidor) + Supabase (base de datos)

## Qué ya está hecho
- **Supabase** (proyecto `nkuhazrdxqrtobmklutp`, plan gratis, región us-east-2): rol dedicado `nova_app` (sin superusuario, máx. 20 conexiones, contraseña solo como verificador SCRAM). Las tablas las crea el propio servidor al arrancar (migraciones 001–004).
- **Endurecimiento para Supabase** (`004_supabase_hardening.sql`): la Data API de Supabase (roles `anon`/`authenticated`) no tiene ningún privilegio sobre las tablas de NOVA y todas tienen RLS activado sin políticas. Todo acceso pasa por el servidor.
- **TLS verificado** hacia la base de datos con la CA raíz de Supabase (`server/certs/supabase-root-2021.crt`); nunca se desactiva la verificación.
- `render.yaml` (Blueprint), `REGISTRATION_CODE` para que nadie más cree el primer usuario, y `APP_ENCRYPTION_KEY` generada por Render.

## Lo que haces tú (una vez)
1. Entra en https://dashboard.render.com con tu cuenta de GitHub.
2. **New → Blueprint** → elige el repositorio `AngelMv-18/Proyecto-app` y la rama `claude/nova-finance-personal-9ihdwm`.
3. Render pide 3 valores (`DATABASE_URL`, `REGISTRATION_CODE`, `VAPID_PRIVATE_KEY`): pégalos desde el archivo de secretos que te entregué en esta conversación. **No los subas al repositorio.**
4. **Apply**. La primera compilación tarda unos minutos. La URL será parecida a `https://nova-finance.onrender.com`.
5. Abre la URL, crea tu cuenta con el código de instalación y, en el teléfono, Chrome → **Agregar a pantalla de inicio**.
6. Pásame la URL para activar el “despertador” en Supabase (pg_cron hace ping cada 10 min) y revisar los avisos de seguridad.

## Limitaciones del plan gratis
- Render duerme el servicio tras 15 min sin tráfico; el ping desde Supabase lo evita (un servicio 24/7 usa ~744 de las 750 h gratis al mes).
- Supabase gratis pausa proyectos tras ~1 semana sin actividad; el ping diario del servidor a la base lo mantiene activo.
- Sin disco persistente en Render (no hace falta: todo está en Supabase). Haz respaldos desde Perfil → “Descargar respaldo”.

## Compartir la app (invitaciones)
- El registro está **cerrado**: solo entra quien tenga un enlace de invitación (Perfil → **Compartir app**).
- Cada enlace tiene número de usos (1–50) y vencimiento (1–30 días), y se puede revocar. En la base solo se guarda su hash.
- Cada persona tiene su propia cuenta y solo ve sus datos (aislamiento probado). Como dueño del servidor y de Supabase,
  técnicamente puedes acceder a la base de datos: avísales que es una versión de prueba.
- `ALLOW_REGISTRATION=true` abriría el registro a cualquiera con el enlace de la app (no recomendado para finanzas).

## Iniciar sesión con Google (y conectar Gmail en un clic)
Lo haces una vez en https://console.cloud.google.com (gratis):
1. Crea un proyecto → **APIs y servicios → Pantalla de consentimiento OAuth**: tipo *Externo*, nombre de la app, tu correo.
   Para el inicio de sesión bastan los alcances básicos `openid`, `email`, `profile` (no requieren verificación de Google).
2. **Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web**. En *URI de redireccionamiento autorizados* agrega:
   - `https://TU-DOMINIO/api/auth/google/callback` (inicio de sesión)
   - `https://TU-DOMINIO/api/integrations/gmail/callback` (Gmail)
   (con `TU-DOMINIO` = `nova-finance-m0qb.onrender.com` o tu dominio propio; puedes poner ambos).
3. En Render → servicio → **Environment**: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`. Render redepliega y aparece el botón **Continuar con Google**.
4. **Gmail** usa el permiso `gmail.readonly`, que Google considera *restringido*: mientras la app esté en modo *Pruebas*, agrega
   en la pantalla de consentimiento a cada persona como *usuario de prueba* (máx. 100) y los tokens de Gmail caducan a los 7 días
   (hay que reconectar). Publicarla para cualquiera exige verificación de Google y una evaluación de seguridad de pago.
   El **inicio de sesión** con Google sí funciona para todos sin esa verificación.

## Dominio propio (p. ej. `novafinanzas.app`)
1. Compra el dominio en un registrador (Cloudflare Registrar, Namecheap, Porkbun…). `.com`/`.app` cuestan ≈ 10–20 USD/año;
   `.hn` se compra en registradores hondureños y suele costar bastante más. Revisa disponibilidad allí mismo
   (nombres como `novafinance.com` probablemente estén ocupados; prueba variantes: `novafinanzas.app`, `minova.app`, `novahn.com`).
2. Render → servicio → **Settings → Custom Domains → Add**: escribe el dominio (o `app.tudominio.com`). Render te da un registro
   **CNAME** (o A/ALIAS para el dominio raíz) para crear en tu registrador. El certificado HTTPS es automático y gratis.
3. En Render → **Environment** agrega `PUBLIC_URL=https://tudominio` (enlaces de invitación, Google y huella dependen de ella).
4. En Google Cloud agrega los dos URI de redirección con el dominio nuevo.
5. **Huella:** las huellas quedan ligadas al dominio. Al cambiar de dominio, cada persona debe registrar su huella otra vez
   (Perfil → Apariencia y bloqueo con huella). La app instalada también hay que reinstalarla desde el dominio nuevo.
6. Opcional: actualiza el ping de Supabase (`nova-keepalive`) al dominio nuevo; el de `onrender.com` sigue funcionando.
