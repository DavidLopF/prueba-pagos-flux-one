import type { RecordAuditEvent } from '../../application/record-audit-event.js';
import { InvalidAuditEventError } from '../../domain/errors.js';
import type { Logger } from '../logger.js';

/**
 * What the consumer must do with a delivery:
 * - ack:         stored now or already stored before (duplicate) → remove it from the queue.
 * - dead-letter: the message itself is bad, retrying cannot fix it → nack(requeue=false) → DLQ.
 * - retry:       infrastructure failure (database down…) → nack(requeue=true) after a pause.
 */
export type DeliveryOutcome = 'ack' | 'dead-letter' | 'retry';

/** Broker-agnostic decision logic, kept apart from amqplib so it can be unit tested. Never throws. */
export class AuditMessageHandler {
  constructor(
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly logger: Logger,
  ) {}

  async handle(content: Buffer, messageId?: string): Promise<DeliveryOutcome> {
    let message: unknown;
    try {
      message = JSON.parse(content.toString('utf8'));
    } catch {
      this.logger.warn({ messageId }, 'audit message is not valid JSON; dead-lettering it');
      return 'dead-letter';
    }

    try {
      const { eventId, recorded } = await this.recordAuditEvent.execute(message);
      this.logger.info({ eventId, duplicate: !recorded }, recorded ? 'audit event recorded' : 'duplicate audit event ignored');
      return 'ack';
    } catch (error) {
      if (error instanceof InvalidAuditEventError) {
        // Only the reason is logged, never the payload (it carries account data).
        this.logger.warn({ messageId, reason: error.reason }, 'invalid audit event; dead-lettering it');
        return 'dead-letter';
      }
      this.logger.error({ messageId, err: error }, 'could not store audit event; it will be retried');
      return 'retry';
    }
  }
}
