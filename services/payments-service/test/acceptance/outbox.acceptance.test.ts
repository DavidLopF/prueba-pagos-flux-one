import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MessagePublisher, type OutgoingMessage, OutboxRelay } from '../../src/infrastructure/messaging/OutboxRelay.js';
import { countRows, resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail } from '../support/FakeBankRail.js';
import { createHarness, type Harness, USERS } from '../support/harness.js';

/** Broker falso: se puede "apagar" para simular RabbitMQ caído. */
class FakeBroker implements MessagePublisher {
  available = true;
  readonly delivered: OutgoingMessage[] = [];

  async publish(message: OutgoingMessage): Promise<void> {
    if (!this.available) throw new Error('RabbitMQ no disponible');
    this.delivered.push(message);
  }
}

const internalTransfer = { type: 'INTERNAL', fromAccount: 'ACC-001', toAccount: 'ACC-002', amount: '10.00' };

describe('Transactional Outbox (PostgreSQL real)', () => {
  let db: TestDatabase;
  let h: Harness;
  let broker: FakeBroker;
  let relay: OutboxRelay;

  beforeAll(async () => {
    db = await startDatabase();
  });
  afterAll(async () => {
    await h?.app.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await resetData(db.pool);
    h = createHarness(db.pool, new FakeBankRail());
    broker = new FakeBroker();
    relay = new OutboxRelay(db.pool, broker);
  });

  const outboxEvents = async () =>
    (
      await db.pool.query<{ event_type: string; aggregate_id: string; published_at: Date | null }>(
        'SELECT event_type, aggregate_id, published_at FROM payment_schema.outbox ORDER BY seq',
      )
    ).rows;

  it('[AUD-01] cada cambio de estado deja su evento en el outbox dentro de la misma transacción', async () => {
    const { id } = (await h.createTransfer(USERS.alice, internalTransfer)).json();
    await h.reverse(USERS.alice, id);

    const events = await outboxEvents();
    expect(events.map((event) => event.event_type)).toEqual([
      'TRANSFER_CREATED',
      'TRANSFER_COMPLETED',
      'TRANSFER_REVERSAL_REQUESTED',
      'TRANSFER_REVERSED',
    ]);
    expect(events.every((event) => event.aggregate_id === id)).toBe(true);
  });

  it('[AUD-01] si la transacción hace rollback el evento no existe', async () => {
    const response = await h.createTransfer(USERS.carol, {
      type: 'INTERNAL',
      fromAccount: 'ACC-003',
      toAccount: 'ACC-001',
      amount: '1.00',
    });

    expect(response.statusCode).toBe(422);
    expect(await countRows(db.pool, 'outbox')).toBe(0);
    expect(await countRows(db.pool, 'transfers')).toBe(0);
  });

  it('[AUD-02] con el broker caído la transferencia se procesa igual y los eventos esperan sin perderse', async () => {
    broker.available = false;

    const response = await h.createTransfer(USERS.alice, internalTransfer);
    expect(response.statusCode).toBe(201);
    expect(await relay.publishPending()).toBe(0);
    expect((await outboxEvents()).every((event) => event.published_at === null)).toBe(true);
    const { rows } = await db.pool.query('SELECT publish_attempts, last_error FROM payment_schema.outbox ORDER BY seq LIMIT 1');
    expect(rows[0]).toMatchObject({ publish_attempts: 1, last_error: 'RabbitMQ no disponible' });

    broker.available = true;
    expect(await relay.publishPending()).toBe(2);
    expect(broker.delivered.map((message) => message.routingKey)).toEqual(['transfer.created', 'transfer.completed']);
    expect((await outboxEvents()).every((event) => event.published_at !== null)).toBe(true);
  });

  it('[AUD-03] published_at se marca solo tras la confirmación y el mensaje respeta el contrato del evento', async () => {
    const { id } = (await h.createTransfer(USERS.alice, internalTransfer)).json();

    await relay.publishPending();
    expect(await relay.publishPending()).toBe(0); // nada se publica dos veces

    const first = broker.delivered[0]!;
    const envelope = JSON.parse(first.body.toString());
    expect(first.messageId).toBe(envelope.eventId);
    expect(envelope).toMatchObject({
      eventType: 'TRANSFER_CREATED',
      aggregateId: id,
      actorId: USERS.alice,
      participantIds: [USERS.alice, USERS.bob],
      payload: { transferId: id, amount: '10.00', status: 'PENDING', previousStatus: null },
    });
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
  });
});
