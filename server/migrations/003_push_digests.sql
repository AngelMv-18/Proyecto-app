-- Notificaciones push (Web Push / VAPID) y resúmenes periódicos.
CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failures   int NOT NULL DEFAULT 0
);
CREATE INDEX push_user_idx ON push_subscriptions(user_id);
ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
