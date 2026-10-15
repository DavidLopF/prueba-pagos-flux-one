import type { Account } from '../domain/model/Account.js';
import type { Transfer, TransferStatus, TransferType } from '../domain/model/Transfer.js';

/** Representación pública de una transferencia (schema Transfer de docs/openapi.yaml). */
export interface TransferView {
  id: string;
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: 'COP';
  status: TransferStatus;
  attempts: number;
  requiresManualReview: boolean;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BalanceView {
  accountId: string;
  balance: string;
  currency: 'COP';
}

/** Resultado de un comando idempotente: `replayed` indica que se reprodujo una respuesta guardada. */
export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

export function toTransferView(transfer: Transfer): TransferView {
  return {
    id: transfer.id,
    type: transfer.type,
    fromAccount: transfer.fromAccount,
    toAccount: transfer.toAccount,
    amount: transfer.amount.toString(),
    currency: 'COP',
    status: transfer.status,
    attempts: transfer.attempts,
    requiresManualReview: transfer.requiresManualReview,
    failureReason: transfer.failureReason,
    createdAt: transfer.createdAt.toISOString(),
    updatedAt: transfer.updatedAt.toISOString(),
  };
}

export function toBalanceView(account: Account): BalanceView {
  return { accountId: account.id, balance: account.balance.toString(), currency: 'COP' };
}
