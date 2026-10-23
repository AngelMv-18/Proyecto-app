-- Verificación en dos pasos (TOTP) y tipos de cambio manuales.
ALTER TABLE users ADD COLUMN totp_secret text;          -- cifrado (AES-256-GCM) si hay APP_ENCRYPTION_KEY
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_last_step bigint;     -- evita reutilizar el mismo código
CREATE TABLE recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz
);
CREATE INDEX recovery_user_idx ON recovery_codes(user_id);

-- Tipo de cambio que el usuario define: 1 unidad de `currency` = `rate` unidades de su moneda principal.
CREATE TABLE fx_rates (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency   text NOT NULL,
  rate       numeric(18,8) NOT NULL CHECK (rate > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);

-- Limitador de intentos persistente (sirve con varias réplicas y sobrevive a reinicios).
CREATE TABLE rate_limits (
  key        text PRIMARY KEY,
  hits       int NOT NULL,
  window_start timestamptz NOT NULL
);

-- Paso intermedio del inicio de sesión cuando hay 2FA (token de un solo uso, 5 minutos).
CREATE TABLE login_tickets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0
);
