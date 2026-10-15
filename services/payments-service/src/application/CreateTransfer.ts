import { DomainError } from '../domain/errors.js';
import type { Account } from '../domain/model/Account.js';
import { Money } from '../domain/model/Money.js';
import { Transfer, type TransferType } from '../domain/model/Transfer.js';
import type { UnitOfWork } from '../domain/ports/repositories.js';
import type { Clock, IdGenerator } from '../domain/ports/system.js';
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

      const isInternal = command.type === 'INTERNAL';
      const locked = await tx.accounts.lockByIds(
        isInternal ? [command.fromAccount, command.toAccount] : [command.fromAccount],
      );
      const source = findAccount(locked, command.fromAccount);
      source.assertOwnedBy(command.userId);
      const destination = isInternal ? findAccount(locked, command.toAccount) : null;

      const now = this.clock.now();
      const transfer = Transfer.create({
        id: this.ids.newId(),
        type: command.type,
        fromAccount: command.fromAccount,
        toAccount: command.toAccount,
        amount,
        ownerId: source.ownerId,
        counterpartyOwnerId: destination?.ownerId ?? null,
        now,
      });

      // Lanza INSUFFICIENT_FUNDS antes de escribir nada. En EXTERNAL el débito retiene el dinero
      // hasta que el riel responda (EXT-01).
      source.debit(amount);
      await tx.accounts.saveBalance(source);
      if (destination) {
        destination.credit(amount);
        await tx.accounts.saveBalance(destination);
        transfer.markCompleted({ now, actorId: command.userId });
      }

      await tx.transfers.insert(transfer);
      await tx.outbox.append(transfer.pullEvents());

      const view = toTransferView(transfer);
      await tx.idempotency.complete(command.userId, command.idempotencyKey, view);
      return { result: view, replayed: false };
    });
  }
}

function findAccount(accounts: Account[], id: string): Account {
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) {
    throw new DomainError('ACCOUNT_NOT_FOUND', `La cuenta ${id} no existe`);
  }
  return account;
}
