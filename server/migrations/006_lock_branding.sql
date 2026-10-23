-- Bloqueo con huella (WebAuthn, autenticador del propio teléfono) y apariencia de la instalación.

-- Credenciales de desbloqueo: solo la clave PÚBLICA del autenticador; la huella nunca sale del teléfono.
CREATE TABLE webauthn_credentials (
  id           text PRIMARY KEY,            -- credential ID (base64url)
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   bytea NOT NULL,
  counter      bigint NOT NULL DEFAULT 0,
  transports   text[] NOT NULL DEFAULT '{}',
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX webauthn_user_idx ON webauthn_credentials(user_id);

-- Estado de bloqueo por sesión: se exige en el servidor (sin desbloqueo reciente la API responde 423).
ALTER TABLE sessions ADD COLUMN unlocked_until timestamptz;
ALTER TABLE sessions ADD COLUMN challenge text;
ALTER TABLE sessions ADD COLUMN challenge_expires timestamptz;

-- Apariencia de la instalación (nombre, colores, logotipo): visible también en la pantalla de acceso e ícono.
CREATE TABLE instance_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE brand_assets (
  name       text PRIMARY KEY CHECK (name IN ('icon-192','icon-512')),
  mime       text NOT NULL CHECK (mime = 'image/png'),
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Mismo endurecimiento que 004 para las tablas nuevas (Supabase).
DO $$
DECLARE r record; supa boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('webauthn_credentials','instance_settings','brand_assets')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    IF supa THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.relname); END IF;
  END LOOP;
END $$;
