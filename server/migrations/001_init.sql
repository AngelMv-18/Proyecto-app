-- NOVA FINANCE · esquema inicial
-- Los importes se guardan en unidades menores (centavos) como BIGINT: nunca flotantes.
-- No existe saldo almacenado: el saldo SIEMPRE se calcula (saldo inicial + movimientos confirmados).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  currency      text NOT NULL DEFAULT 'HNL',
  timezone      text NOT NULL DEFAULT 'America/Tegucigalpa',
  locale        text NOT NULL DEFAULT 'es-HN',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingest_token_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('cash','bank','debit_card','credit_card','wallet','savings','other')),
  currency       text NOT NULL,
  opening_balance bigint NOT NULL DEFAULT 0,
  opening_date   date NOT NULL DEFAULT current_date,
  credit_limit   bigint CHECK (credit_limit IS NULL OR credit_limit >= 0),
  archived       boolean NOT NULL DEFAULT false,
  color          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES categories(id) ON DELETE CASCADE,
  name       text NOT NULL,
  nature     text NOT NULL DEFAULT 'discretionary' CHECK (nature IN ('essential','discretionary','extraordinary')),
  kind       text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  icon       text,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, parent_id, name)
);

CREATE TABLE goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  target_amount bigint NOT NULL CHECK (target_amount > 0),
  target_date   date,
  priority      int NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  contribution_amount bigint CHECK (contribution_amount IS NULL OR contribution_amount > 0),
  contribution_frequency text CHECK (contribution_frequency IS NULL OR contribution_frequency IN ('weekly','monthly')),
  -- cuenta real donde está separado el dinero; NULL = reserva virtual
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE debts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('owe','owed')), -- owe: yo debo; owed: me deben
  counterparty  text NOT NULL,
  original_amount bigint NOT NULL CHECK (original_amount > 0),
  currency      text NOT NULL,
  due_date      date,
  interest_rate numeric(7,4), -- % anual, informativo
  notes         text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recurring (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription','bill','service','debt','other')),
  amount      bigint NOT NULL CHECK (amount > 0),
  currency    text NOT NULL,
  frequency   text NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','yearly')),
  next_date   date NOT NULL,
  account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  debt_id     uuid REFERENCES debts(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','suggested')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('csv','ofx','email','notification')),
  filename    text,
  account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  total_rows  int NOT NULL DEFAULT 0,
  created_rows int NOT NULL DEFAULT 0,
  duplicate_rows int NOT NULL DEFAULT 0,
  skipped_rows int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('income','expense','transfer','debt_payment','debt_collection','refund','adjustment','goal_saving')),
  amount        bigint NOT NULL,
  to_amount     bigint, -- importe recibido en la cuenta destino si las monedas difieren
  currency      text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  category_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  merchant      text,
  payment_method text,
  description   text,
  tags          text[] NOT NULL DEFAULT '{}',
  nature        text CHECK (nature IS NULL OR nature IN ('essential','discretionary','extraordinary')),
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','void')),
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email','import','notification','bank_api')),
  needs_review  boolean NOT NULL DEFAULT false,
  external_id   text,
  duplicate_of  uuid,
  source_label  text,
  import_id     uuid REFERENCES imports(id) ON DELETE SET NULL,
  debt_id       uuid REFERENCES debts(id),
  goal_id       uuid REFERENCES goals(id),
  refund_of     uuid REFERENCES transactions(id),
  void_reason   text,
  has_receipt   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amount_sign CHECK (
    (type IN ('adjustment','goal_saving') AND amount <> 0) OR (type NOT IN ('adjustment','goal_saving') AND amount > 0)
  ),
  CONSTRAINT transfer_dest CHECK (type <> 'transfer' OR (to_account_id IS NOT NULL AND to_account_id <> account_id)),
  CONSTRAINT debt_link CHECK (type NOT IN ('debt_payment','debt_collection') OR debt_id IS NOT NULL),
  CONSTRAINT goal_link CHECK (type <> 'goal_saving' OR goal_id IS NOT NULL),
  CONSTRAINT refund_link CHECK (type <> 'refund' OR refund_of IS NOT NULL)
);
CREATE INDEX tx_user_date_idx ON transactions(user_id, occurred_at DESC);
CREATE INDEX tx_account_idx ON transactions(account_id);
CREATE INDEX tx_review_idx ON transactions(user_id) WHERE needs_review;
-- Idempotencia: el mismo identificador externo no puede entrar dos veces por usuario.
CREATE UNIQUE INDEX tx_external_uniq ON transactions(user_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE receipts (
  transaction_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime           text NOT NULL,
  data           bytea NOT NULL
);

CREATE TABLE budgets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      text NOT NULL CHECK (period IN ('monthly','weekly')),
  amount      bigint NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category_id, period)
);

CREATE TABLE reconciliations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of        date NOT NULL,
  bank_balance bigint NOT NULL,
  app_balance  bigint NOT NULL,
  difference   bigint NOT NULL,
  adjustment_tx uuid REFERENCES transactions(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('gmail')),
  status     text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','revoked')),
  account_email text,
  refresh_token_enc text, -- AES-256-GCM; la clave vive solo en el entorno del servidor
  config     jsonb NOT NULL DEFAULT '{}'::jsonb, -- remitentes, etiquetas, cuenta por defecto
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  severity   text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title      text NOT NULL,
  body       text NOT NULL,
  dedupe_key text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  entity     text NOT NULL,
  entity_id  text,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_user_idx ON audit_log(user_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log(entity, entity_id);

-- Efectos contables por cuenta de cada movimiento CONFIRMADO. Fuente única de verdad de los saldos.
CREATE VIEW v_effects AS
  SELECT t.id AS tx_id, t.user_id, t.account_id, t.occurred_at,
         CASE t.type
           WHEN 'income' THEN t.amount WHEN 'refund' THEN t.amount WHEN 'debt_collection' THEN t.amount
           WHEN 'adjustment' THEN t.amount
           WHEN 'expense' THEN -t.amount WHEN 'debt_payment' THEN -t.amount
           WHEN 'transfer' THEN -t.amount
           WHEN 'goal_saving' THEN CASE WHEN t.to_account_id IS NOT NULL THEN -t.amount ELSE 0 END
         END AS delta
    FROM transactions t WHERE t.status = 'confirmed'
  UNION ALL
  SELECT t.id, t.user_id, t.to_account_id, t.occurred_at, COALESCE(t.to_amount, t.amount)
    FROM transactions t
   WHERE t.status = 'confirmed' AND t.to_account_id IS NOT NULL AND t.type IN ('transfer','goal_saving');
