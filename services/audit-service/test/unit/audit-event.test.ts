import { describe, expect, it } from 'vitest';
import { parseAuditEvent } from '../../src/domain/audit-event.js';
import { InvalidAuditEventError } from '../../src/domain/errors.js';
import { ALICE, BOB, transferEvent } from '../support/fixtures.js';

describe('parseAuditEvent', () => {
  it('[AUD-04] convierte un mensaje del contrato de payments en un AuditEvent', () => {
    const message = transferEvent({
      eventType: 'TRANSFER_COMPLETED',
      status: 'COMPLETED',
      occurredAt: '2026-10-15T10:00:00.123Z',
      actorId: null,
      participantIds: [ALICE, BOB],
    });

    const event = parseAuditEvent(message);

    expect(event).toEqual({
      eventId: message.eventId,
      transferId: message.aggregateId,
      eventType: 'TRANSFER_COMPLETED',
      status: 'COMPLETED',
      actorId: null,
      participantIds: [ALICE, BOB],
      occurredAt: new Date('2026-10-15T10:00:00.123Z'),
      payload: message.payload,
    });
  });

  it('[AUD-06] rechaza con InvalidAuditEventError un mensaje que no cumple el contrato', () => {
    const valid = transferEvent();
    const invalidMessages: Record<string, unknown> = {
      'no es un objeto': [valid],
      'eventId ausente': { ...valid, eventId: undefined },
      'eventId no UUID': { ...valid, eventId: 'evt-1' },
      'eventType desconocido': { ...valid, eventType: 'TRANSFER_DELETED' },
      'aggregateId no UUID': { ...valid, aggregateId: 42 },
      'occurredAt sin zona horaria': { ...valid, occurredAt: '2026-10-15T10:00:00' },
      'occurredAt no es fecha': { ...valid, occurredAt: 'ayer' },
      'actorId no UUID': { ...valid, actorId: 'alice' },
      'participantIds vacío': { ...valid, participantIds: [] },
      'participantIds con valor no UUID': { ...valid, participantIds: [ALICE, 'bob'] },
      'payload ausente': { ...valid, payload: null },
      'payload.status desconocido': { ...valid, payload: { ...valid.payload, status: 'DONE' } },
    };

    for (const [description, message] of Object.entries(invalidMessages)) {
      expect(() => parseAuditEvent(message), description).toThrow(InvalidAuditEventError);
    }
  });
});
