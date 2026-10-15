import type { Account } from '../model/Account.js';
import type { Transfer, TransferEvent, TransferStatus } from '../model/Transfer.js';

export interface AccountRepository {
  findById(id: string): Promise<Account | null>;
  findByOwner(ownerId: string): Promise<Account[]>;
  /** Bloquea las cuentas (SELECT … FOR UPDATE) en orden de id ascendente. Devuelve solo las que existen. */
  lockByIds(ids: string[]): Promise<Account[]>;
  saveBalance(account: Account): Promise<void>;
}

export interface TransferRepository {
  insert(transfer: Transfer): Promise<void>;
  findById(id: string): Promise<Transfer | null>;
  findByIdForUpdate(id: string): Promise<Transfer | null>;
  /** UPDATE condicional: solo aplica si en BD el estado sigue siendo `expectedStatus`. */
  update(transfer: Transfer, expectedStatus: TransferStatus): Promise<boolean>;
  listByAccount(accountId: string): Promise<Transfer[]>;
  /**
   * Reclama hasta `limit` transferencias con trabajo pendiente en el riel cuyo turno ya llegó,
   * incrementa `attempts` y las "alquila" hasta `leaseUntil` (otro worker no las toma mientras tanto).
   */
  claimDueForRail(now: Date, leaseUntil: Date, limit: number): Promise<Transfer[]>;
}

export type IdempotencyCheck =
  | { kind: 'NEW' }
  | { kind: 'REPLAY'; response: unknown }
  | { kind: 'MISMATCH' };

export interface IdempotencyStore {
  /**
   * Registra la key dentro de la transacción actual. Si otra transacción concurrente tiene la misma
   * key, espera a que termine y luego devuelve REPLAY (mismo payload) o MISMATCH (payload distinto).
   */
  begin(ownerId: string, key: string, fingerprint: string): Promise<IdempotencyCheck>;
  /** Guarda la respuesta exitosa antes del commit para poder reproducirla. */
  complete(ownerId: string, key: string, response: unknown): Promise<void>;
}

/** Transactional Outbox: los eventos se guardan en la misma transacción que el cambio de estado. */
export interface Outbox {
  append(events: TransferEvent[]): Promise<void>;
}

export interface TransactionContext {
  accounts: AccountRepository;
  transfers: TransferRepository;
  idempotency: IdempotencyStore;
  outbox: Outbox;
}

/** Ejecuta `work` en una transacción de BD: commit si termina bien, rollback si lanza. */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
