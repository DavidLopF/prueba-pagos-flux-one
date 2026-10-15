import { describe, expect, it } from 'vitest';
import { RecordAuditEvent } from '../../src/application/record-audit-event.js';
import { InvalidAuditEventError } from '../../src/domain/errors.js';
import { transferEvent } from '../support/fixtures.js';
import { InMemoryAuditEventRepository } from '../support/in-memory-audit-event-repository.js';

describe('RecordAuditEvent', () => {
  it('[AUD-04] almacena un evento nuevo', async () => {
    const repository = new InMemoryAuditEventRepository();
    const message = transferEvent();

    const result = await new RecordAuditEvent(repository).execute(message);

    expect(result).toEqual({ eventId: message.eventId, recorded: true });
    expect(repository.events).toHaveLength(1);
  });

  it('[AUD-04] el mismo evento entregado dos veces se almacena una sola vez', async () => {
    const repository = new InMemoryAuditEventRepository();
    const recordAuditEvent = new RecordAuditEvent(repository);
    const message = transferEvent();

    await recordAuditEvent.execute(message);
    const redelivery = await recordAuditEvent.execute(structuredClone(message));

    expect(redelivery).toEqual({ eventId: message.eventId, recorded: false });
    expect(repository.events).toHaveLength(1);
  });

  it('[AUD-06] un mensaje inválido se rechaza sin tocar el repositorio', async () => {
    const repository = new InMemoryAuditEventRepository();

    await expect(
      new RecordAuditEvent(repository).execute({ ...transferEvent(), eventType: 'NOPE' }),
    ).rejects.toThrow(InvalidAuditEventError);
    expect(repository.events).toHaveLength(0);
  });
});
