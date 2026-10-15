/**
 * The message cannot become an audit event (wrong shape, unknown event type, data the store rejects…).
 * It is a permanent condition: retrying the same message will never succeed, so the consumer
 * dead-letters it instead of requeueing it.
 */
export class InvalidAuditEventError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid audit event: ${reason}`);
    this.name = 'InvalidAuditEventError';
  }
}
