import { DomainError } from '../domain/errors.js';
import type { UnitOfWork } from '../domain/ports/repositories.js';
import type { Clock, IdGenerator } from '../domain/ports/system.js';
import { type IdempotentResult, type TransferView, toTransferView } from './views.js';

export interface ReverseTransferCommand {
  userId: string;
  idempotencyKey: string;
  transferId: string;
}

/**
 * REV-01..06. La fila de la transferencia se bloquea (FOR UPDATE), así dos reversos concurrentes
 * se serializan y el segundo ve un estado distinto de COMPLETED → 409 (una sola vez).
 * INTERNAL: se revierte en la misma transacción. EXTERNAL: queda REVERSAL_PENDING para el worker.
 */
export class ReverseTransfer {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ReverseTransferCommand): Promise<IdempotentResult<TransferView>> {
    const fingerprint = JSON.stringify(['REVERSE_TRANSFER', command.transferId]);

    return this.uow.run(async (tx) => {
      const idempotency = await tx.idempotency.begin(command.userId, command.idempotencyKey, fingerprint);
      if (idempotency.kind === 'MISMATCH') {
        throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó con otro payload');
      }
      if (idempotency.kind === 'REPLAY') {
        return { result: idempotency.response as TransferView, replayed: true };
      }

      const transfer = await tx.transfers.findByIdForUpdate(command.transferId);
      if (!transfer || transfer.ownerId !== command.userId) {
        throw new DomainError('NOT_FOUND', 'Transferencia no encontrada');
      }

      const now = this.clock.now();
      const ctx = { now, actorId: command.userId };
      const previousStatus = transfer.status;
      transfer.requestReversal(this.ids.newId(), ctx); // INVALID_STATE si no está COMPLETED

      if (transfer.type === 'INTERNAL') {
        const locked = await tx.accounts.lockByIds([transfer.fromAccount, transfer.toAccount]);
        const source = locked.find((account) => account.id === transfer.fromAccount);
        const destination = locked.find((account) => account.id === transfer.toAccount);
        if (!source || !destination) {
          throw new Error(`Cuentas de la transferencia ${transfer.id} inexistentes`);
        }
        destination.debit(transfer.amount); // REV-04: INSUFFICIENT_FUNDS → rollback, sigue COMPLETED
        source.credit(transfer.amount);
        await tx.accounts.saveBalance(destination);
        await tx.accounts.saveBalance(source);
        transfer.markReversed(ctx);
      }

      if (!(await tx.transfers.update(transfer, previousStatus))) {
        throw new DomainError('INVALID_STATE', 'La transferencia cambió de estado');
      }
      await tx.outbox.append(transfer.pullEvents());

      const view = toTransferView(transfer);
      await tx.idempotency.complete(command.userId, command.idempotencyKey, view);
      return { result: view, replayed: false };
    });
  }
}
