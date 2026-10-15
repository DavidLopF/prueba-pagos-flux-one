import type { PoolClient } from 'pg';
import { Money } from '../../domain/model/Money.js';
import { Transfer, type TransferStatus, type TransferType } from '../../domain/model/Transfer.js';
import type { TransferRepository } from '../../domain/ports/repositories.js';

interface TransferRow {
  id: string;
  type: TransferType;
  from_account: string;
  to_account: string;
  amount: string;
  status: TransferStatus;
  owner_id: string;
  counterparty_owner_id: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  requires_manual_review: boolean;
  reversal_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, type, from_account, to_account, amount, status, owner_id, counterparty_owner_id, attempts,
  next_attempt_at, requires_manual_review, reversal_id, failure_reason, created_at, updated_at`;

const toTransfer = (row: TransferRow) =>
  Transfer.restore({
    id: row.id,
    type: row.type,
    fromAccount: row.from_account,
    toAccount: row.to_account,
    amount: Money.fromString(row.amount),
    status: row.status,
    ownerId: row.owner_id,
    counterpartyOwnerId: row.counterparty_owner_id,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    requiresManualReview: row.requires_manual_review,
    reversalId: row.reversal_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class PgTransferRepository implements TransferRepository {
  constructor(private readonly client: PoolClient) {}

  async insert(transfer: Transfer): Promise<void> {
    const t = transfer.snapshot();
    await this.client.query(
      `INSERT INTO payment_schema.transfers (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        t.id, t.type, t.fromAccount, t.toAccount, t.amount.toString(), t.status, t.ownerId, t.counterpartyOwnerId,
        t.attempts, t.nextAttemptAt, t.requiresManualReview, t.reversalId, t.failureReason, t.createdAt, t.updatedAt,
      ],
    );
  }

  async findById(id: string): Promise<Transfer | null> {
    const { rows } = await this.client.query<TransferRow>(
      `SELECT ${COLUMNS} FROM payment_schema.transfers WHERE id = $1`,
      [id],
    );
    return rows[0] ? toTransfer(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Transfer | null> {
    const { rows } = await this.client.query<TransferRow>(
      `SELECT ${COLUMNS} FROM payment_schema.transfers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? toTransfer(rows[0]) : null;
  }

  async update(transfer: Transfer, expectedStatus: TransferStatus): Promise<boolean> {
    const t = transfer.snapshot();
    const result = await this.client.query(
      `UPDATE payment_schema.transfers
          SET status = $2, attempts = $3, next_attempt_at = $4, requires_manual_review = $5,
              reversal_id = $6, failure_reason = $7, updated_at = $8
        WHERE id = $1 AND status = $9`,
      [t.id, t.status, t.attempts, t.nextAttemptAt, t.requiresManualReview, t.reversalId, t.failureReason,
        t.updatedAt, expectedStatus],
    );
    return result.rowCount === 1;
  }

  async listByAccount(accountId: string): Promise<Transfer[]> {
    const { rows } = await this.client.query<TransferRow>(
      `SELECT ${COLUMNS} FROM payment_schema.transfers
        WHERE from_account = $1 OR to_account = $1
        ORDER BY created_at DESC, id
        LIMIT 100`,
      [accountId],
    );
    return rows.map(toTransfer);
  }

  async claimDueForRail(now: Date, leaseUntil: Date, limit: number): Promise<Transfer[]> {
    // SKIP LOCKED: varias instancias del worker se reparten el trabajo sin bloquearse.
    const { rows } = await this.client.query<TransferRow>(
      `UPDATE payment_schema.transfers
          SET attempts = attempts + 1, next_attempt_at = $2
        WHERE id IN (
          SELECT id FROM payment_schema.transfers
           WHERE status IN ('PENDING', 'UNKNOWN', 'REVERSAL_PENDING') AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}`,
      [now, leaseUntil, limit],
    );
    return rows.map(toTransfer);
  }
}
