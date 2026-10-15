import { DatabaseError, type Pool } from 'pg';
import type { AuditEvent, AuditEventType, TransferStatus } from '../../domain/audit-event.js';
import { InvalidAuditEventError } from '../../domain/errors.js';
import type { AuditEventRepository } from '../../domain/ports/audit-event-repository.js';

interface AuditEventRow {
  event_id: string;
  transfer_id: string;
  event_type: string;
  status: string;
  actor_id: string | null;
  participant_ids: string[];
  occurred_at: Date;
  payload: Record<string, unknown>;
}

export class PgAuditEventRepository implements AuditEventRepository {
  constructor(private readonly pool: Pool) {}

  async saveIfAbsent(event: AuditEvent): Promise<boolean> {
    try {
      // Single autocommit statement: when the promise resolves the row is committed.
      // ON CONFLICT DO NOTHING makes a redelivered eventId a no-op (rowCount 0) instead of an error.
      const result = await this.pool.query(
        `INSERT INTO audit_schema.audit_events
           (event_id, transfer_id, event_type, status, actor_id, participant_ids, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.transferId,
          event.eventType,
          event.status,
          event.actorId,
          event.participantIds,
          event.occurredAt,
          JSON.stringify(event.payload),
        ],
      );
      return result.rowCount === 1;
    } catch (error) {
      // SQLSTATE class 22 (data exception, e.g. "\u0000" inside jsonb) and 23 (integrity violation)
      // depend on the message content, not on the database health: retrying would loop forever.
      if (error instanceof DatabaseError && (error.code?.startsWith('22') || error.code?.startsWith('23'))) {
        throw new InvalidAuditEventError(`rejected by the database (SQLSTATE ${error.code})`);
      }
      throw error;
    }
  }

  async findByTransfer(transferId: string, viewerId: string): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<AuditEventRow>(
      `SELECT event_id, transfer_id, event_type, status, actor_id, participant_ids, occurred_at, payload
         FROM audit_schema.audit_events
        WHERE transfer_id = $1
          AND $2 = ANY (participant_ids)
        ORDER BY occurred_at ASC, received_at ASC`,
      [transferId, viewerId],
    );
    return rows.map(toAuditEvent);
  }
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    eventId: row.event_id,
    transferId: row.transfer_id,
    // Safe casts: rows are only written by saveIfAbsent with events validated by parseAuditEvent.
    eventType: row.event_type as AuditEventType,
    status: row.status as TransferStatus,
    actorId: row.actor_id,
    participantIds: row.participant_ids,
    occurredAt: row.occurred_at,
    payload: row.payload,
  };
}
