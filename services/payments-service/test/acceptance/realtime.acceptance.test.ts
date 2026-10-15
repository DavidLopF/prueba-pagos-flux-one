import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MessagePublisher, type OutgoingMessage, OutboxRelay } from '../../src/infrastructure/messaging/OutboxRelay.js';
import { RabbitMqRealtimeConsumer } from '../../src/infrastructure/realtime/RabbitMqRealtimeConsumer.js';
import { resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail } from '../support/FakeBankRail.js';
import { createHarness, type Harness, tokenFor, USERS } from '../support/harness.js';
import { connectWs } from '../support/websocket.js';

/** "Broker" en memoria: entrega lo que publica el outbox directamente al consumidor de tiempo real. */
class LoopbackBroker implements MessagePublisher {
  constructor(private readonly consumer: RabbitMqRealtimeConsumer) {}

  async publish(message: OutgoingMessage): Promise<void> {
    this.consumer.handle(message.body);
  }
}

describe('Tiempo real por WebSocket (PostgreSQL real)', () => {
  let db: TestDatabase;
  let h: Harness;
  let relay: OutboxRelay;

  beforeAll(async () => {
    db = await startDatabase();
  });
  afterAll(async () => {
    await h?.app.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await h?.app.close();
    await resetData(db.pool);
    h = createHarness(db.pool, new FakeBankRail());
    const consumer = new RabbitMqRealtimeConsumer('amqp://no-usado', 'payments.events', h.realtime, () => undefined);
    relay = new OutboxRelay(db.pool, new LoopbackBroker(consumer));
  });

  it('[RT-01] una transferencia avisa al emisor y al receptor, pero no a un tercero', async () => {
    const alice = await connectWs(h.app, `/ws?token=${tokenFor(USERS.alice)}`);
    const bob = await connectWs(h.app, `/ws?token=${tokenFor(USERS.bob)}`);
    const carol = await connectWs(h.app, `/ws?token=${tokenFor(USERS.carol)}`);
    for (const client of [alice, bob, carol]) await client.waitFor((message) => message.type === 'ready');

    const { id } = (
      await h.createTransfer(USERS.alice, { type: 'INTERNAL', fromAccount: 'ACC-001', toAccount: 'ACC-002', amount: '10.00' })
    ).json();
    await relay.publishPending();

    for (const client of [alice, bob]) {
      const update = await client.waitFor((message) => message.eventType === 'TRANSFER_COMPLETED');
      expect(update).toMatchObject({ type: 'transfer.updated', transferId: id, status: 'COMPLETED' });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(carol.messages.filter((message) => message.type === 'transfer.updated')).toEqual([]);
    for (const client of [alice, bob, carol]) client.ws.terminate();
  });

  it('[RT-02] sin token o con un token inválido la conexión se cierra con 4401', async () => {
    const noToken = await connectWs(h.app, '/ws');
    const badToken = await connectWs(h.app, `/ws?token=${tokenFor(USERS.alice, { secret: 'otro-secreto' })}`);

    expect((await noToken.closed).code).toBe(4401);
    expect((await badToken.closed).code).toBe(4401);
    expect(noToken.messages).toEqual([]);
  });

  it('[RT-02] cuando el token vence con la conexión abierta se cierra con 4401 para renovarlo', async () => {
    const client = await connectWs(h.app, `/ws?token=${tokenFor(USERS.alice, { expiresIn: 1 })}`);
    await client.waitFor((message) => message.type === 'ready');

    const { code } = await client.closed;

    expect(code).toBe(4401);
  });
});
