import type { Pool } from 'pg';

export interface OutgoingMessage {
  routingKey: string;
  messageId: string;
  body: Buffer;
}

/** Puerto de salida hacia el broker. Debe resolver SOLO cuando el broker confirmó el mensaje. */
export interface MessagePublisher {
  publish(message: OutgoingMessage): Promise<void>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  routing_key: string;
  actor_id: string | null;
  participant_ids: string[];
  payload: unknown;
  occurred_at: Date;
}

/**
 * Relay del Transactional Outbox (AUD-02, AUD-03).
 * Lee eventos no publicados en orden, los publica y marca published_at solo tras el confirm del broker.
 * Si el broker no está, los eventos esperan en la tabla: nunca se pierden. Entrega at-least-once
 * (si el commit falla después del confirm, se republica y el consumidor deduplica por eventId).
 */
export class OutboxRelay {
  constructor(
    private readonly pool: Pool,
    private readonly publisher: MessagePublisher,
    private readonly batchSize = 50,
  ) {}

  async publishPending(): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, aggregate_id, event_type, routing_key, actor_id, participant_ids, payload, occurred_at
           FROM payment_schema.outbox
          WHERE published_at IS NULL
          ORDER BY seq
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      for (const row of rows) {
        try {
          await this.publisher.publish({
            routingKey: row.routing_key,
            messageId: row.id,
            body: Buffer.from(JSON.stringify(toEnvelope(row))),
          });
        } catch (error) {
          await client.query(
            'UPDATE payment_schema.outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE id = $1',
            [row.id, error instanceof Error ? error.message : String(error)],
          );
          break; // Broker caído: se corta el lote para conservar el orden; se reintenta en el próximo ciclo.
        }
        await client.query(
          'UPDATE payment_schema.outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = $1',
          [row.id],
        );
        published++;
      }
      await client.query('COMMIT');
      return published;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Contrato del evento consumido por audit-service. */
function toEnvelope(row: OutboxRow) {
  return {
    eventId: row.id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    participantIds: row.participant_ids,
    payload: row.payload,
  };
}
