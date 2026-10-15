import type { PoolClient } from 'pg';
import type { TransferEvent } from '../../domain/model/Transfer.js';
import type { Outbox } from '../../domain/ports/repositories.js';

/** TRANSFER_REVERSAL_REQUESTED → transfer.reversal_requested */
export const routingKeyFor = (eventType: string) => `transfer.${eventType.replace(/^TRANSFER_/, '').toLowerCase()}`;

export class PgOutbox implements Outbox {
  constructor(private readonly client: PoolClient) {}

  async append(events: TransferEvent[]): Promise<void> {
    for (const event of events) {
      await this.client.query(
        `INSERT INTO payment_schema.outbox
           (aggregate_id, event_type, routing_key, actor_id, participant_ids, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6::jsonb, $7)`,
        [
          event.transferId,
          event.eventType,
          routingKeyFor(event.eventType),
          event.actorId,
          event.participantIds,
          JSON.stringify(event.payload),
          event.occurredAt,
        ],
      );
    }
  }
}
