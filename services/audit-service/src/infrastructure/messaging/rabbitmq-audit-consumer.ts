import { setTimeout as delay } from 'node:timers/promises';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { Logger } from '../logger.js';
import type { AuditMessageHandler } from './audit-message-handler.js';

export const PAYMENTS_EXCHANGE = 'payments.events';
export const AUDIT_QUEUE = 'audit.transfer-events';
export const DEAD_LETTER_EXCHANGE = 'audit.dlx';
export const DEAD_LETTER_QUEUE = 'audit.transfer-events.dlq';
const BINDING_KEY = 'transfer.#';
const PREFETCH = 10;

export interface RabbitMqAuditConsumerOptions {
  url: string;
  handler: AuditMessageHandler;
  logger: Logger;
  /** Pause between connection attempts while the broker is unreachable. */
  reconnectDelayMs?: number;
  /** Pause before requeueing a message that failed for a transient reason (e.g. database down). */
  retryDelayMs?: number;
}

/**
 * Feeds `payments.events` into the audit store (AUD-02, AUD-04).
 * - Manual ack only after the insert has committed: at-least-once delivery + idempotent insert.
 * - Bad message → nack(requeue=false): the queue dead-letters it to audit.dlx → DLQ.
 * - Transient failure → nack(requeue=true) after retryDelayMs.
 * - start() never fails: while the broker is down it retries in the background, so HTTP keeps serving.
 */
export class RabbitMqAuditConsumer {
  private readonly reconnectDelayMs: number;
  private readonly retryDelayMs: number;
  private connection: ChannelModel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Tail of the sequential processing chain (see enqueue). */
  private processing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RabbitMqAuditConsumerOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  /** Call once. Connects in the background and keeps reconnecting until stop(). */
  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.processing; // let the delivery in progress be stored and acked
    const connection = this.connection;
    this.connection = null;
    // Deliveries still unacked go back to the queue when the connection closes.
    await connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.stopping) return;
    let connection: ChannelModel | undefined;
    try {
      connection = await amqp.connect(this.options.url, {
        timeout: 5_000,
        clientProperties: { connection_name: 'audit-service' },
      });
      const current = connection;
      // An 'error' event without listener would crash the process; 'close' always follows it.
      current.on('error', (error: unknown) => this.options.logger.warn({ err: error }, 'RabbitMQ connection error'));
      current.on('close', () => this.onConnectionClosed(current));

      const channel = await current.createChannel();
      channel.on('error', (error: unknown) => this.options.logger.warn({ err: error }, 'RabbitMQ channel error'));
      // Our only channel was closed (by the broker or with the connection): drop the connection so
      // the 'close' handler reconnects and declares everything again. No-op if already closing.
      channel.on('close', () => void current.close().catch(() => undefined));

      await declareTopology(channel);
      await channel.prefetch(PREFETCH);
      await channel.consume(
        AUDIT_QUEUE,
        (message) => {
          if (message === null) {
            // The broker cancelled the consumer (e.g. queue deleted): reconnect to recreate it.
            void current.close().catch(() => undefined);
            return;
          }
          this.enqueue(channel, message);
        },
        { noAck: false },
      );

      if (this.stopping) {
        // stop() ran while we were connecting.
        await current.close().catch(() => undefined);
        return;
      }
      this.connection = current;
      this.options.logger.info({ queue: AUDIT_QUEUE }, 'consuming audit events');
    } catch (error) {
      // Expected while the broker is down: one compact line per attempt instead of a stack trace.
      this.options.logger.warn({ reason: summarize(error), retryInMs: this.reconnectDelayMs }, 'RabbitMQ unavailable; will retry');
      this.scheduleReconnect();
      // Release a half-built connection (e.g. the topology declaration failed). Not awaited: on a
      // half-open socket close() waits for a broker reply that may never come.
      void connection?.close().catch(() => undefined);
    }
  }

  private onConnectionClosed(closed: ChannelModel): void {
    if (this.connection === closed) this.connection = null;
    if (this.stopping) return;
    this.options.logger.warn({ retryInMs: this.reconnectDelayMs }, 'RabbitMQ connection closed; reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectDelayMs);
  }

  /**
   * Deliveries are processed one at a time, in delivery order, so rows are inserted in publication
   * order and received_at is a meaningful tie-break for equal occurredAt. Prefetch still keeps the
   * next messages buffered locally, saving a round-trip per message.
   */
  private enqueue(channel: Channel, message: ConsumeMessage): void {
    this.processing = this.processing
      .then(() => this.process(channel, message))
      // Never let a rejection break the chain: every later delivery would be silently skipped.
      .catch((error: unknown) => this.options.logger.error({ err: error }, 'unexpected error processing delivery'));
  }

  private async process(channel: Channel, message: ConsumeMessage): Promise<void> {
    // Shutting down: leave it unacked, the broker requeues it when the connection closes.
    if (this.stopping) return;
    const messageId: string | undefined = message.properties.messageId;
    const outcome = await this.options.handler.handle(message.content, messageId);
    try {
      if (outcome === 'ack') {
        channel.ack(message);
      } else if (outcome === 'dead-letter') {
        channel.nack(message, false, false);
      } else {
        await delay(this.retryDelayMs);
        channel.nack(message, false, true);
      }
    } catch (error) {
      // The channel closed meanwhile (delivery tags die with it). The broker redelivers the message
      // and the insert is idempotent, so nothing is lost or duplicated.
      this.options.logger.warn({ err: error, messageId }, 'could not settle delivery; the broker will redeliver it');
    }
  }
}

/** e.g. "connect ETIMEDOUT", "Handshake terminated by server: 403 (ACCESS-REFUSED)", "ECONNREFUSED". */
function summarize(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node reports "broker down" as an AggregateError (IPv4 + IPv6 attempts) with an empty message.
  return error.message || (error as NodeJS.ErrnoException).code || error.name;
}

async function declareTopology(channel: Channel): Promise<void> {
  // Same declaration as the publisher (payments-service); asserting is idempotent.
  await channel.assertExchange(PAYMENTS_EXCHANGE, 'topic', { durable: true });
  // Fanout: every message dead-lettered by our queue lands in the DLQ, whatever its routing key.
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
  await channel.assertQueue(AUDIT_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE },
  });
  await channel.bindQueue(AUDIT_QUEUE, PAYMENTS_EXCHANGE, BINDING_KEY);
}
