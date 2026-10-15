import type { AuditEvent } from '../audit-event.js';

export interface AuditEventRepository {
  /**
   * Stores the event unless one with the same eventId already exists (at-least-once delivery
   * means duplicates are normal). Resolves true if it was inserted, false if it was a duplicate.
   * Throws InvalidAuditEventError if the store rejects the data itself (retrying cannot help).
   */
  saveIfAbsent(event: AuditEvent): Promise<boolean>;

  /**
   * Events of the transfer that `viewerId` participates in, ordered by occurredAt ascending
   * (ties broken by arrival order). Unknown transfer or no participation → empty list.
   */
  findByTransfer(transferId: string, viewerId: string): Promise<AuditEvent[]>;
}
