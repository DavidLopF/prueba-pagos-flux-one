import type { PoolClient } from 'pg';
import { Money } from '../../domain/model/Money.js';
import { PaymentLink, type PaymentLinkStatus } from '../../domain/model/PaymentLink.js';
import type { PaymentLinkRepository } from '../../domain/ports/repositories.js';

interface PaymentLinkRow {
  id: string;
  account_id: string;
  owner_id: string;
  amount: string;
  description: string;
  status: PaymentLinkStatus;
  expires_at: Date;
  paid_transfer_id: string | null;
  paid_at: Date | null;
  created_at: Date;
}

const COLUMNS = 'id, account_id, owner_id, amount, description, status, expires_at, paid_transfer_id, paid_at, created_at';

const toPaymentLink = (row: PaymentLinkRow) =>
  PaymentLink.restore({
    id: row.id,
    accountId: row.account_id,
    ownerId: row.owner_id,
    amount: Money.fromString(row.amount),
    description: row.description,
    status: row.status,
    expiresAt: row.expires_at,
    paidTransferId: row.paid_transfer_id,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  });

export class PgPaymentLinkRepository implements PaymentLinkRepository {
  constructor(private readonly client: PoolClient) {}

  async insert(link: PaymentLink): Promise<void> {
    const l = link.snapshot();
    await this.client.query(
      `INSERT INTO payment_schema.payment_links (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [l.id, l.accountId, l.ownerId, l.amount.toString(), l.description, l.status, l.expiresAt, l.paidTransferId,
        l.paidAt, l.createdAt],
    );
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const { rows } = await this.client.query<PaymentLinkRow>(
      `SELECT ${COLUMNS} FROM payment_schema.payment_links WHERE id = $1`,
      [id],
    );
    return rows[0] ? toPaymentLink(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<PaymentLink | null> {
    const { rows } = await this.client.query<PaymentLinkRow>(
      `SELECT ${COLUMNS} FROM payment_schema.payment_links WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? toPaymentLink(rows[0]) : null;
  }

  async markPaid(link: PaymentLink): Promise<boolean> {
    const l = link.snapshot();
    const result = await this.client.query(
      `UPDATE payment_schema.payment_links SET status = 'PAID', paid_transfer_id = $2, paid_at = $3
        WHERE id = $1 AND status = 'ACTIVE'`,
      [l.id, l.paidTransferId, l.paidAt],
    );
    return result.rowCount === 1;
  }

  async listByAccount(accountId: string): Promise<PaymentLink[]> {
    const { rows } = await this.client.query<PaymentLinkRow>(
      `SELECT ${COLUMNS} FROM payment_schema.payment_links WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
      [accountId],
    );
    return rows.map(toPaymentLink);
  }
}
