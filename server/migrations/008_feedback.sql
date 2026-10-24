-- Comentarios de quienes prueban la app: problemas, ideas y calificación. Los ve el administrador.
CREATE TABLE feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('problem','idea','other')),
  message    text NOT NULL CHECK (length(message) BETWEEN 3 AND 2000),
  rating     smallint CHECK (rating BETWEEN 1 AND 5),
  screen     text,
  device     text,
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','done')),
  reply      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_created_idx ON feedback(created_at DESC);
CREATE INDEX feedback_user_idx ON feedback(user_id);

DO $$
DECLARE supa boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
BEGIN
  ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
  IF supa THEN REVOKE ALL ON TABLE public.feedback FROM anon, authenticated; END IF;
END $$;
