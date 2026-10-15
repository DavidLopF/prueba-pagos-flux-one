import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordAuditEvent } from '../../src/application/record-audit-event.js';
import { AuditMessageHandler } from '../../src/infrastructure/messaging/audit-message-handler.js';
import {
  AUDIT_QUEUE,
  DEAD_LETTER_QUEUE,
  PAYMENTS_EXCHANGE,
  RabbitMqAuditConsumer,
} from '../../src/infrastructure/messaging/rabbitmq-audit-consumer.js';
import { PgAuditEventRepository } from '../../src/infrastructure/persistence/pg-audit-event-repository.js';
import { silentLogger, transferEvent, waitFor } from '../support/fixtures.js';
import { startAuditDatabase, type AuditDatabase } from '../support/postgres.js';

describe('RabbitMqAuditConsumer con RabbitMQ y PostgreSQL reales', () => {
  let rabbit: StartedTestContainer;
  let db: AuditDatabase;
  let url: string;
  let consumer: RabbitMqAuditConsumer;
  // Test-side connection, playing payments-service (publisher) and an operator (queue inspection).
  let broker: ChannelModel;
  let publisher: Channel;

  async function connectPublisher(): Promise<void> {
    broker = await amqp.connect(url);
    broker.on('error', () => undefined); // forced closes emit 'error'
    publisher = await broker.createChannel();
    publisher.on('error', () => undefined);
  }

  /** Throwaway channel per check: checkQueue on a missing queue closes the channel. */
  async function queueState(queue: string): Promise<{ messageCount: number; consumerCount: number } | null> {
    const channel = await broker.createChannel();
    channel.on('error', () => undefined);
    try {
      const { messageCount, consumerCount } = await channel.checkQueue(queue);
      return { messageCount, consumerCount };
    } catch {
      return null;
    } finally {
      await channel.close().catch(() => undefined);
    }
  }

  function publish(body: ReturnType<typeof transferEvent> | string): void {
    const isEvent = typeof body !== 'string';
    publisher.publish(PAYMENTS_EXCHANGE, 'transfer.created', Buffer.from(isEvent ? JSON.stringify(body) : body), {
      persistent: true,
      contentType: 'application/json',
      messageId: isEvent ? body.eventId : undefined,
    });
  }

  async function storedCount(eventId: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_schema.audit_events WHERE event_id = $1',
      [eventId],
    );
    return rows[0]?.count ?? 0;
  }

  beforeAll(async () => {
    [rabbit, db] = await Promise.all([
      new GenericContainer('rabbitmq:3-management-alpine')
        .withExposedPorts(5672)
        .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
        .start(),
      startAuditDatabase(),
    ]);
    url = `amqp://guest:guest@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`;

    consumer = new RabbitMqAuditConsumer({
      url,
      handler: new AuditMessageHandler(new RecordAuditEvent(new PgAuditEventRepository(db.pool)), silentLogger),
      logger: silentLogger,
      reconnectDelayMs: 250,
      retryDelayMs: 50,
    });
    consumer.start();
    await connectPublisher();
    await waitFor(async () => (await queueState(AUDIT_QUEUE))?.consumerCount === 1);
  });

  afterAll(async () => {
    await consumer?.stop();
    await broker?.close().catch(() => undefined);
    await Promise.all([rabbit?.stop(), db?.stop()]);
  });

  it('[AUD-04] un evento entregado dos veces (mismo eventId) se guarda una sola vez', async () => {
    const event = transferEvent();
    const sentinel = transferEvent();

    publish(event);
    publish(event);
    publish(sentinel);

    // Deliveries are processed in order: once the sentinel is stored, both copies were handled.
    await waitFor(async () => (await storedCount(sentinel.eventId)) === 1);
    expect(await storedCount(event.eventId)).toBe(1);
  });

  it('[AUD-06] un mensaje inválido va a la DLQ y no bloquea los siguientes', async () => {
    const sentinel = transferEvent();

    publish('{not json');
    publish({ ...transferEvent(), eventType: 'TRANSFER_DELETED' });
    publish(sentinel);

    await waitFor(async () => (await storedCount(sentinel.eventId)) === 1);
    await waitFor(async () => (await queueState(DEAD_LETTER_QUEUE))?.messageCount === 2);
  });

  it('[AUD-02] si RabbitMQ corta la conexión, el consumidor se reconecta y los eventos siguen llegando a audit_schema', async () => {
    const result = await rabbit.exec(['rabbitmqctl', 'close_all_connections', 'simulated network failure']);
    expect(result.exitCode).toBe(0);
    await connectPublisher(); // ours was closed too

    const event = transferEvent();
    publish(event);

    await waitFor(async () => (await storedCount(event.eventId)) === 1);
  });

  it('[AUD-04] todas las entregas se confirmaron: al cerrar el consumidor no vuelve nada a la cola', async () => {
    await consumer.stop(); // unacked deliveries would be requeued here and show up in messageCount

    expect((await queueState(AUDIT_QUEUE))?.messageCount).toBe(0);
  });
});
