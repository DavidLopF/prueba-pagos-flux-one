import { DomainError } from '../domain/errors.js';
import { Money } from '../domain/model/Money.js';
import type { TransferType } from '../domain/model/Transfer.js';
import type { UnitOfWork } from '../domain/ports/repositories.js';
import type { Clock, IdGenerator } from '../domain/ports/system.js';
import { executeTransfer } from './executeTransfer.js';
import { type IdempotentResult, type TransferView, toTransferView } from './views.js';

export interface CreateTransferCommand {
  userId: string;
  idempotencyKey: string;
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: string;
}

/**
 * TR-01..07, IDEM-01..04, EXT-01.
 * Todo ocurre en UNA transacción: key de idempotencia, bloqueo de cuentas, débito/crédito,
 * transferencia, eventos del outbox y respuesta guardada. Si algo falla, rollback total.
 */
export class CreateTransfer {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateTransferCommand): Promise<IdempotentResult<TransferView>> {
    const amount = Money.fromString(command.amount);
    if (!amount.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'El monto debe ser mayor que cero');
    }
    if (command.fromAccount === command.toAccount) {
      throw new DomainError('SAME_ACCOUNT', 'La cuenta origen y la destino deben ser distintas');
    }
    // Huella canónica del payload: "100.5" y "100.50" son el mismo request.
    const fingerprint = JSON.stringify([
      'CREATE_TRANSFER',
      command.type,
      command.fromAccount,
      command.toAccount,
      amount.toString(),
    ]);

    return this.uow.run(async (tx) => {
      // Primero la key: un request concurrente con la misma key se bloquea aquí, antes de tocar cuentas.
      const idempotency = await tx.idempotency.begin(command.userId, command.idempotencyKey, fingerprint);
      if (idempotency.kind === 'MISMATCH') {
        throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó con otro payload');
      }
      if (idempotency.kind === 'REPLAY') {
        return { result: idempotency.response as TransferView, replayed: true };
      }

      const transfer = await executeTransfer(tx, {
        id: this.ids.newId(),
        userId: command.userId,
        type: command.type,
        fromAccount: command.fromAccount,
        toAccount: command.toAccount,
        amount,
        now: this.clock.now(),
      });

      const view = toTransferView(transfer);
      await tx.idempotency.complete(command.userId, command.idempotencyKey, view);
      return { result: view, replayed: false };
    });
  }
}
