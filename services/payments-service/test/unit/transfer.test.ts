import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/model/Money.js';
import { Transfer, type TransferType } from '../../src/domain/model/Transfer.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const now = new Date('2026-10-15T13:30:00.000Z');
const ctx = { now, actorId: null };

function newTransfer(type: TransferType = 'EXTERNAL', amount = '100.00'): Transfer {
  return Transfer.create({
    id: 'a0000000-0000-0000-0000-000000000001',
    type,
    fromAccount: 'ACC-001',
    toAccount: type === 'INTERNAL' ? 'ACC-002' : 'EXT-1',
    amount: Money.fromString(amount),
    ownerId: OWNER,
    counterpartyOwnerId: null,
    now,
  });
}

describe('Transfer: máquina de estados', () => {
  it('[TR-02] no se puede crear con monto cero', () => {
    expect(() => newTransfer('INTERNAL', '0.00')).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
  });

  it('[TR-05] no se puede crear con origen igual a destino', () => {
    expect(() =>
      Transfer.create({
        id: 'x',
        type: 'INTERNAL',
        fromAccount: 'ACC-001',
        toAccount: 'ACC-001',
        amount: Money.fromString('1.00'),
        ownerId: OWNER,
        counterpartyOwnerId: OWNER,
        now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SAME_ACCOUNT' }));
  });

  it('[EXT-01] una externa nace PENDING, lista para el worker, con evento TRANSFER_CREATED', () => {
    const transfer = newTransfer();

    expect(transfer.status).toBe('PENDING');
    expect(transfer.nextAttemptAt).toEqual(now);
    expect(transfer.pullEvents().map((event) => event.eventType)).toEqual(['TRANSFER_CREATED']);
  });

  it('[EXT-05] PENDING → UNKNOWN → COMPLETED es válido y un estado terminal no cambia', () => {
    const transfer = newTransfer();
    transfer.markUnknown(ctx);
    transfer.markCompleted(ctx);

    expect(transfer.status).toBe('COMPLETED');
    expect(transfer.nextAttemptAt).toBeNull();
    expect(() => transfer.markFailed('X', ctx)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('[EXT-03] FAILED es terminal y guarda el motivo', () => {
    const transfer = newTransfer();
    transfer.markFailed('RAIL_REJECTED', ctx);

    expect(transfer.failureReason).toBe('RAIL_REJECTED');
    expect(() => transfer.markCompleted(ctx)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('[REV-02] solo una transferencia COMPLETED puede pedir reverso', () => {
    const transfer = newTransfer();

    expect(() => transfer.requestReversal('r-1', ctx)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('[REV-03] después de REVERSED no se puede volver a reversar', () => {
    const transfer = newTransfer('INTERNAL');
    transfer.markCompleted(ctx);
    transfer.requestReversal('r-1', ctx);
    transfer.markReversed(ctx);

    expect(() => transfer.requestReversal('r-2', ctx)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('[REV-05] un reverso rechazado vuelve a COMPLETED y reinicia los intentos del riel', () => {
    const transfer = newTransfer();
    transfer.markCompleted(ctx);
    transfer.requestReversal('r-1', ctx);
    expect(transfer).toMatchObject({ status: 'REVERSAL_PENDING', reversalId: 'r-1', attempts: 0 });

    transfer.rejectReversal('RAIL_REJECTED', ctx);

    expect(transfer).toMatchObject({ status: 'COMPLETED', reversalId: null });
  });

  it('[EXT-04] el reintento usa backoff exponencial con tope y marca revisión manual tras N intentos', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3 };
    const delays: number[] = [];
    for (let attempts = 1; attempts <= 8; attempts++) {
      const transfer = Transfer.restore({ ...newTransfer().snapshot(), attempts });
      transfer.scheduleRetry(now, policy);
      delays.push(transfer.nextAttemptAt!.getTime() - now.getTime());
      expect(transfer.requiresManualReview).toBe(attempts >= 3);
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('[AUD-01] cada transición emite un evento con estado previo, nuevo y participantes', () => {
    const transfer = newTransfer();
    transfer.pullEvents();
    transfer.markUnknown(ctx);
    transfer.markFailed('RAIL_REJECTED', ctx);

    expect(transfer.pullEvents().map((event) => [event.eventType, event.payload.previousStatus, event.payload.status])).toEqual([
      ['TRANSFER_UNKNOWN', 'PENDING', 'UNKNOWN'],
      ['TRANSFER_FAILED', 'UNKNOWN', 'FAILED'],
    ]);
    expect(transfer.pullEvents()).toEqual([]);
  });
});
