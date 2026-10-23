-- Endurecimiento para PostgreSQL gestionado (Supabase): la Data API (PostgREST) expone el esquema "public" a los roles
-- anon/authenticated. NOVA no usa esa API: todo acceso pasa por el servidor. Se bloquea por completo:
--  1) sin privilegios para anon/authenticated sobre tablas, secuencias y funciones de NOVA;
--  2) RLS activado en todas las tablas sin políticas (deniega por defecto) como segunda barrera.
-- En un PostgreSQL normal (sin esos roles) solo se activa RLS, que no afecta al dueño de las tablas (el servidor).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;
-- La vista de efectos contables se evalúa con los permisos de quien consulta (no del creador).
ALTER VIEW v_effects SET (security_invoker = true);
