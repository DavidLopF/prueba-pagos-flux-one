-- Append-only audit trail of transfer events received from payments-service (AUD-04, AUD-05).
-- The schema and the audit_user role are created by db/init (never here).
CREATE TABLE audit_schema.audit_events (
  event_id        uuid        PRIMARY KEY,            -- idempotency: one row per eventId
  transfer_id     uuid        NOT NULL,
  event_type      text        NOT NULL,
  status          text        NOT NULL,
  actor_id        uuid        NULL,
  participant_ids uuid[]      NOT NULL,               -- owners allowed to read the event
  occurred_at     timestamptz NOT NULL,
  payload         jsonb       NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_transfer_id_occurred_at_idx
  ON audit_schema.audit_events (transfer_id, occurred_at);
