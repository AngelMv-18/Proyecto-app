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
