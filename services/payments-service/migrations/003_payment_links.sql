-- Opcional: links de cobro (docs/spec.md §11). EXPIRED no se guarda: se deriva de expires_at.
CREATE TABLE payment_schema.payment_links (
  id                uuid PRIMARY KEY,
  account_id        text NOT NULL REFERENCES payment_schema.accounts (id),
  owner_id          uuid NOT NULL,
  amount            numeric(18,2) NOT NULL CHECK (amount > 0),
  currency          char(3) NOT NULL DEFAULT 'COP',
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 140),
  status            text NOT NULL CHECK (status IN ('ACTIVE', 'PAID')),
  expires_at        timestamptz NOT NULL,
  paid_transfer_id  uuid UNIQUE REFERENCES payment_schema.transfers (id),
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL,
  CHECK ((status = 'PAID') = (paid_transfer_id IS NOT NULL))
);
CREATE INDEX payment_links_account_idx ON payment_schema.payment_links (account_id, created_at DESC);
