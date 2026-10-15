-- payment_schema: cuentas, transferencias, idempotencia y outbox (CLAUDE.md §2, §3, §5).
CREATE TABLE payment_schema.accounts (
  id          text PRIMARY KEY,
  owner_id    uuid NOT NULL,
  balance     numeric(18,2) NOT NULL CHECK (balance >= 0),
  currency    char(3) NOT NULL DEFAULT 'COP',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_owner_idx ON payment_schema.accounts (owner_id);

CREATE TABLE payment_schema.transfers (
  id                      uuid PRIMARY KEY,
  type                    text NOT NULL CHECK (type IN ('INTERNAL', 'EXTERNAL')),
  from_account            text NOT NULL REFERENCES payment_schema.accounts (id),
  to_account              text NOT NULL,
  amount                  numeric(18,2) NOT NULL CHECK (amount > 0),
  currency                char(3) NOT NULL DEFAULT 'COP',
  status                  text NOT NULL CHECK (status IN ('PENDING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REVERSAL_PENDING', 'REVERSED')),
  owner_id                uuid NOT NULL,
  counterparty_owner_id   uuid,
  attempts                integer NOT NULL DEFAULT 0,
  next_attempt_at         timestamptz,
  requires_manual_review  boolean NOT NULL DEFAULT false,
  reversal_id             uuid UNIQUE,
  failure_reason          text,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CHECK (from_account <> to_account)
);
CREATE INDEX transfers_from_idx ON payment_schema.transfers (from_account, created_at DESC);
CREATE INDEX transfers_to_idx ON payment_schema.transfers (to_account, created_at DESC);
-- Índice parcial para el worker del riel: solo las que tienen trabajo pendiente.
CREATE INDEX transfers_rail_due_idx ON payment_schema.transfers (next_attempt_at)
  WHERE status IN ('PENDING', 'UNKNOWN', 'REVERSAL_PENDING');

-- La PK (owner_id, key) es el "lock" que serializa reintentos concurrentes con la misma key.
CREATE TABLE payment_schema.idempotency_keys (
  owner_id       uuid NOT NULL,
  key            text NOT NULL,
  request_hash   text NOT NULL,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE payment_schema.outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  aggregate_id      uuid NOT NULL,
  event_type        text NOT NULL,
  routing_key       text NOT NULL,
  actor_id          uuid,
  participant_ids   uuid[] NOT NULL,
  payload           jsonb NOT NULL,
  occurred_at       timestamptz NOT NULL,
  published_at      timestamptz,
  publish_attempts  integer NOT NULL DEFAULT 0,
  last_error        text
);
CREATE INDEX outbox_unpublished_idx ON payment_schema.outbox (seq) WHERE published_at IS NULL;
