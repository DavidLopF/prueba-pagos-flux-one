import { parseAuditEvent } from '../domain/audit-event.js';
import type { AuditEventRepository } from '../domain/ports/audit-event-repository.js';

export interface RecordAuditEventResult {
  eventId: string;
  /** false when the event had already been stored (duplicate delivery). */
  recorded: boolean;
}

/**
 * Stores a transfer event published by payments-service. Idempotent by eventId (AUD-04):
 * recording the same event twice leaves a single row and is not an error.
 */
export class RecordAuditEvent {
  constructor(private readonly repository: AuditEventRepository) {}

  /** @throws InvalidAuditEventError when the message is not a valid transfer event. */
  async execute(message: unknown): Promise<RecordAuditEventResult> {
    const event = parseAuditEvent(message);
    const recorded = await this.repository.saveIfAbsent(event);
    return { eventId: event.eventId, recorded };
  }
}
