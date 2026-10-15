import { describe, expect, it } from 'vitest';
import { RecordAuditEvent } from '../../src/application/record-audit-event.js';
import type { AuditEvent } from '../../src/domain/audit-event.js';
import { AuditMessageHandler } from '../../src/infrastructure/messaging/audit-message-handler.js';
import { silentLogger, transferEvent } from '../support/fixtures.js';
import { InMemoryAuditEventRepository } from '../support/in-memory-audit-event-repository.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

function handlerWith(repository: InMemoryAuditEventRepository) {
  return new AuditMessageHandler(new RecordAuditEvent(repository), silentLogger);
}

describe('AuditMessageHandler (decisión ack / dead-letter / retry)', () => {
  it('[AUD-04] confirma (ack) tanto la primera entrega como el duplicado, guardando una sola fila', async () => {
    const repository = new InMemoryAuditEventRepository();
    const handler = handlerWith(repository);
    const message = encode(transferEvent());

    expect(await handler.handle(message)).toBe('ack');
    expect(await handler.handle(message)).toBe('ack');
    expect(repository.events).toHaveLength(1);
  });

  it('[AUD-06] un mensaje que no es JSON o no cumple el contrato va a la DLQ (sin reencolar)', async () => {
    const handler = handlerWith(new InMemoryAuditEventRepository());

    expect(await handler.handle(Buffer.from('{not json'))).toBe('dead-letter');
    expect(await handler.handle(encode({ ...transferEvent(), participantIds: 'alice' }))).toBe('dead-letter');
  });

  it('[AUD-04] un fallo transitorio de la base de datos se reintenta (reencolar)', async () => {
    const repository = new InMemoryAuditEventRepository();
    repository.saveIfAbsent = async (_event: AuditEvent) => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    };

    expect(await handlerWith(repository).handle(encode(transferEvent()))).toBe('retry');
  });
});
