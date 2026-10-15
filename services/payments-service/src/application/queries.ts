import { DomainError } from '../domain/errors.js';
import type { Account } from '../domain/model/Account.js';
import type { UnitOfWork } from '../domain/ports/repositories.js';
import { type BalanceView, type TransferView, toBalanceView, toTransferView } from './views.js';

/** Consultas de solo lectura (TR-08, TR-09, BAL-01, AUTH-06). */
export class TransferQueries {
  constructor(private readonly uow: UnitOfWork) {}

  /** 404 también cuando la transferencia existe pero no es del usuario: no se revela su existencia. */
  getTransfer(userId: string, transferId: string): Promise<TransferView> {
    return this.uow.run(async (tx) => {
      const transfer = await tx.transfers.findById(transferId);
      if (!transfer || !transfer.isVisibleTo(userId)) {
        throw new DomainError('NOT_FOUND', 'Transferencia no encontrada');
      }
      return toTransferView(transfer);
    });
  }

  listAccountTransfers(userId: string, accountId: string): Promise<TransferView[]> {
    return this.uow.run(async (tx) => {
      ownAccount(await tx.accounts.findById(accountId), userId);
      const transfers = await tx.transfers.listByAccount(accountId);
      return transfers.map(toTransferView);
    });
  }

  getBalance(userId: string, accountId: string): Promise<BalanceView> {
    return this.uow.run(async (tx) => toBalanceView(ownAccount(await tx.accounts.findById(accountId), userId)));
  }

  listMyAccounts(userId: string): Promise<BalanceView[]> {
    return this.uow.run(async (tx) => (await tx.accounts.findByOwner(userId)).map(toBalanceView));
  }
}

function ownAccount(account: Account | null, userId: string): Account {
  if (!account) {
    throw new DomainError('NOT_FOUND', 'Cuenta no encontrada');
  }
  account.assertOwnedBy(userId);
  return account;
}
