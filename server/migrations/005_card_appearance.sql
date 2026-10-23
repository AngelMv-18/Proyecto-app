-- Apariencia de tarjeta para cada cuenta (estilo billetera): banco emisor, red, últimos 4 dígitos y colores propios.
-- Nunca se guarda el número completo de la tarjeta.
ALTER TABLE accounts ADD COLUMN bank_code text CHECK (bank_code IS NULL OR bank_code ~ '^[a-z0-9_]{2,30}$');
ALTER TABLE accounts ADD COLUMN card_network text CHECK (card_network IS NULL OR card_network IN ('visa','mastercard','amex','unionpay','none'));
ALTER TABLE accounts ADD COLUMN last4 text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$');
ALTER TABLE accounts ADD COLUMN card_colors text CHECK (card_colors IS NULL OR card_colors ~ '^#[0-9A-Fa-f]{6}(,#[0-9A-Fa-f]{6}){0,2}$');
ALTER TABLE accounts ADD COLUMN sort_order int NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON TABLE accounts FROM anon, authenticated'; END IF;
END $$;
