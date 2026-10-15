import type { AuditEvent } from '../domain/audit-event.js';
import type { AuditEventRepository } from '../domain/ports/audit-event-repository.js';

export interface GetTransferAuditHistoryQuery {
  transferId: string;
  /** Authenticated user (JWT `sub`). */
  viewerId: string;
}

/**
 * Audit timeline of a transfer (AUD-05). Audit cannot read payment_schema, so ownership is decided
 * with the participantIds carried by each event: a user only sees events of transfers they took part in.
 * A foreign or unknown transfer yields an empty list, so the endpoint does not reveal which ids exist.
 */
export class GetTransferAuditHistory {
  constructor(private readonly repository: AuditEventRepository) {}

  execute(query: GetTransferAuditHistoryQuery): Promise<AuditEvent[]> {
    return this.repository.findByTransfer(query.transferId, query.viewerId);
  }
}
