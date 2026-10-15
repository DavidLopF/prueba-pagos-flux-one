import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RabbitMqPublisher } from '../../src/infrastructure/messaging/RabbitMqPublisher.js';
import { RabbitMqRealtimeConsumer } from '../../src/infrastructure/realtime/RabbitMqRealtimeConsumer.js';
import type { RealtimeHub } from '../../src/infrastructure/realtime/RealtimeHub.js';
import { USERS } from '../support/harness.js';

const EXCHANGE = 'payments.events';

/** Espera a que `log` reciba un mensaje que contenga `text`. */
function waitForLog(text: string) {
  let resolve!: () => void;
  const ready = new Promise<void>((r) => (resolve = r));
  return { ready, log: (message: string) => message.includes(text) && resolve() };
}

describe('Fan-out de tiempo real con RabbitMQ real', () => {
  let rabbit: StartedTestContainer;
  let url: string;

  beforeAll(async () => {
    rabbit = await new GenericContainer('rabbitmq:3.13-management-alpine')
      .withExposedPorts(5672)
      .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
      .start();
    url = `amqp://guest:guest@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`;
  });
  afterAll(async () => {
    await rabbit?.stop();
  });

  it('[RT-03] dos instancias reciben el mismo evento, cada una por su cola exclusiva', async () => {
    const hubs = [0, 1].map(() => ({ notify: vi.fn().mockReturnValue(1) }));
    const consumers = hubs.map((hub) => {
      const signal = waitForLog('consumiendo');
      const consumer = new RabbitMqRealtimeConsumer(url, EXCHANGE, hub as unknown as RealtimeHub, signal.log);
      consumer.start();
      return { consumer, ready: signal.ready };
    });
    await Promise.all(consumers.map(({ ready }) => ready));

    const publisherSignal = waitForLog('conectado');
    const publisher = new RabbitMqPublisher(url, EXCHANGE, publisherSignal.log);
    publisher.start();
    await publisherSignal.ready;

    const transferId = randomUUID();
    const envelope = {
      eventId: randomUUID(),
      eventType: 'TRANSFER_COMPLETED',
      aggregateId: transferId,
      occurredAt: new Date().toISOString(),
      actorId: USERS.alice,
      participantIds: [USERS.alice, USERS.bob],
      payload: { transferId, status: 'COMPLETED' },
    };
    await publisher.publish({
      routingKey: 'transfer.completed',
      messageId: envelope.eventId,
      body: Buffer.from(JSON.stringify(envelope)),
    });

    for (const hub of hubs) {
      await vi.waitFor(() => expect(hub.notify).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(hub.notify).toHaveBeenCalledWith([USERS.alice, USERS.bob], {
        type: 'transfer.updated',
        transferId,
        eventType: 'TRANSFER_COMPLETED',
        status: 'COMPLETED',
        occurredAt: envelope.occurredAt,
      });
    }

    await publisher.stop();
    await Promise.all(consumers.map(({ consumer }) => consumer.stop()));
  });
});
