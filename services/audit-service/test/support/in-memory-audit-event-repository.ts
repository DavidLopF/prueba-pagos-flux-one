import type { AuditEvent } from '../../src/domain/audit-event.js';
import type { AuditEventRepository } from '../../src/domain/ports/audit-event-repository.js';

/** Fake of the repository port with the same contract as the PostgreSQL adapter. */
export class InMemoryAuditEventRepository implements AuditEventRepository {
  /** Arrival order (plays the role of received_at). */
  readonly events: AuditEvent[] = [];

  async saveIfAbsent(event: AuditEvent): Promise<boolean> {
    if (this.events.some((stored) => stored.eventId === event.eventId)) return false;
    this.events.push(event);
    return true;
  }

  async findByTransfer(transferId: string, viewerId: string): Promise<AuditEvent[]> {
    return this.events
      .filter((event) => event.transferId === transferId && event.participantIds.includes(viewerId))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()); // stable: ties keep arrival order
  }
}
