-- Tarjeta de débito vinculada a su cuenta bancaria: es el mismo dinero, así que la tarjeta no tiene saldo propio.
-- Sus movimientos se registran en la cuenta vinculada y en pantalla muestra el saldo de esa cuenta.
ALTER TABLE accounts ADD COLUMN linked_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_link_not_self CHECK (linked_account_id IS NULL OR linked_account_id <> id);
CREATE INDEX accounts_linked_idx ON accounts(linked_account_id) WHERE linked_account_id IS NOT NULL;
