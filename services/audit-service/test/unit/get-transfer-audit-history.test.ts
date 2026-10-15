import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetTransferAuditHistory } from '../../src/application/get-transfer-audit-history.js';
import { RecordAuditEvent } from '../../src/application/record-audit-event.js';
import { ALICE, BOB, CAROL, transferEvent } from '../support/fixtures.js';
import { InMemoryAuditEventRepository } from '../support/in-memory-audit-event-repository.js';

describe('GetTransferAuditHistory', () => {
  it('[AUD-05] devuelve los eventos de la transferencia ordenados por occurredAt ascendente', async () => {
    const repository = new InMemoryAuditEventRepository();
    const record = new RecordAuditEvent(repository);
    const transferId = randomUUID();
    // Arrival order differs from occurrence order (at-least-once, retries…).
    await record.execute(transferEvent({ transferId, eventType: 'TRANSFER_COMPLETED', status: 'COMPLETED', occurredAt: '2026-10-15T10:00:02Z' }));
    await record.execute(transferEvent({ transferId, eventType: 'TRANSFER_CREATED', status: 'PENDING', occurredAt: '2026-10-15T10:00:01Z' }));
    await record.execute(transferEvent({ eventType: 'TRANSFER_CREATED', occurredAt: '2026-10-15T10:00:00Z' })); // another transfer

    const history = await new GetTransferAuditHistory(repository).execute({ transferId, viewerId: ALICE });

    expect(history.map((event) => event.eventType)).toEqual(['TRANSFER_CREATED', 'TRANSFER_COMPLETED']);
    expect(history.every((event) => event.transferId === transferId)).toBe(true);
  });

  it('[AUD-05] un usuario que no participa en la transferencia recibe una lista vacía', async () => {
    const repository = new InMemoryAuditEventRepository();
    const transferId = randomUUID();
    await new RecordAuditEvent(repository).execute(transferEvent({ transferId, participantIds: [ALICE, BOB] }));
    const history = new GetTransferAuditHistory(repository);

    expect(await history.execute({ transferId, viewerId: BOB })).toHaveLength(1);
    expect(await history.execute({ transferId, viewerId: CAROL })).toEqual([]);
    expect(await history.execute({ transferId: randomUUID(), viewerId: ALICE })).toEqual([]);
  });
});
