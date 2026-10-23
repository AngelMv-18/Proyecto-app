-- Endurecimiento para PostgreSQL gestionado (Supabase): la Data API (PostgREST) expone el esquema "public" a los roles
-- anon/authenticated. NOVA no usa esa API: todo acceso pasa por el servidor. Se bloquea por completo:
--  1) sin privilegios para anon/authenticated sobre tablas, secuencias y funciones de NOVA;
--  2) RLS activado en todas las tablas sin políticas (deniega por defecto) como segunda barrera.
-- Solo se tocan objetos PROPIEDAD del rol que ejecuta la migración: Supabase tiene funciones propias en "public"
-- (p. ej. rls_auto_enable) sobre las que la app no tiene permisos.
-- En un PostgreSQL normal (sin esos roles) solo se activa RLS, que no afecta al dueño de las tablas (el servidor).
DO $$
DECLARE
  r record;
  supa boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
BEGIN
  FOR r IN SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'S') AND pg_has_role(c.relowner, 'USAGE') AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    IF r.relkind IN ('r', 'p') THEN EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname); END IF;
    IF supa THEN
      IF r.relkind = 'S' THEN EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon, authenticated', r.relname);
      ELSE EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.relname); END IF;
    END IF;
  END LOOP;
  IF supa THEN
    FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', r.oid::regprocedure);
    END LOOP;
    -- Objetos que la app cree en el futuro tampoco quedan expuestos.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;
-- La vista de efectos contables se evalúa con los permisos de quien consulta (no del creador).
ALTER VIEW v_effects SET (security_invoker = true);
