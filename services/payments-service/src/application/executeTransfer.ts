import { DomainError } from '../domain/errors.js';
import type { Account } from '../domain/model/Account.js';
import type { Money } from '../domain/model/Money.js';
import { Transfer, type TransferType } from '../domain/model/Transfer.js';
import type { TransactionContext } from '../domain/ports/repositories.js';

export interface TransferInput {
  id: string;
  userId: string;
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: Money;
  now: Date;
}

/**
 * Mueve el dinero de una transferencia dentro de la transacción `tx` (la usan CreateTransfer y PayPaymentLink):
 * bloquea cuentas en orden, valida propiedad y saldo, debita/acredita y guarda transferencia + eventos del outbox.
 * INTERNAL queda COMPLETED; EXTERNAL queda PENDING con el dinero retenido para el worker del riel.
 */
export async function executeTransfer(tx: TransactionContext, input: TransferInput): Promise<Transfer> {
  const isInternal = input.type === 'INTERNAL';
  const locked = await tx.accounts.lockByIds(isInternal ? [input.fromAccount, input.toAccount] : [input.fromAccount]);
  const source = findAccount(locked, input.fromAccount);
  source.assertOwnedBy(input.userId);
  const destination = isInternal ? findAccount(locked, input.toAccount) : null;

  const transfer = Transfer.create({
    id: input.id,
    type: input.type,
    fromAccount: input.fromAccount,
    toAccount: input.toAccount,
    amount: input.amount,
    ownerId: source.ownerId,
    counterpartyOwnerId: destination?.ownerId ?? null,
    now: input.now,
  });

  // Lanza INSUFFICIENT_FUNDS antes de escribir nada. En EXTERNAL el débito retiene el dinero
  // hasta que el riel responda (EXT-01).
  source.debit(input.amount);
  await tx.accounts.saveBalance(source);
  if (destination) {
    destination.credit(input.amount);
    await tx.accounts.saveBalance(destination);
    transfer.markCompleted({ now: input.now, actorId: input.userId });
  }

  await tx.transfers.insert(transfer);
  await tx.outbox.append(transfer.pullEvents());
  return transfer;
}

function findAccount(accounts: Account[], id: string): Account {
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) {
    throw new DomainError('ACCOUNT_NOT_FOUND', `La cuenta ${id} no existe`);
  }
  return account;
}
