-- Invitaciones para compartir la app y acceso con Google (OpenID Connect).
CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id) ON DELETE CASCADE,
  note        text,
  max_uses    int NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  uses        int NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN invite_id uuid REFERENCES invites(id) ON DELETE SET NULL;
-- Identificador estable de la cuenta de Google ("sub"); nunca se guardan contraseñas de Google.
ALTER TABLE users ADD COLUMN google_sub text UNIQUE;
-- Usuarios creados con Google no tienen contraseña local (marcador que nunca valida).
ALTER TABLE users ADD COLUMN has_password boolean NOT NULL DEFAULT true;

-- Estado de los flujos OAuth (un solo uso, 10 minutos); en base de datos para que funcione con varias réplicas.
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  data       jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

DO $$
DECLARE r record; supa boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
BEGIN
  FOR r IN SELECT unnest(ARRAY['invites','oauth_states']) AS relname LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    IF supa THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.relname); END IF;
  END LOOP;
END $$;
