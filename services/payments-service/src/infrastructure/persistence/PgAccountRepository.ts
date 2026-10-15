import type { PoolClient } from 'pg';
import { Account } from '../../domain/model/Account.js';
import { Money } from '../../domain/model/Money.js';
import type { AccountRepository } from '../../domain/ports/repositories.js';

interface AccountRow {
  id: string;
  owner_id: string;
  balance: string; // pg devuelve NUMERIC como string: nunca pasa por number
}

const toAccount = (row: AccountRow) => new Account(row.id, row.owner_id, Money.fromString(row.balance));

export class PgAccountRepository implements AccountRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(id: string): Promise<Account | null> {
    const { rows } = await this.client.query<AccountRow>(
      'SELECT id, owner_id, balance FROM payment_schema.accounts WHERE id = $1',
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async findByOwner(ownerId: string): Promise<Account[]> {
    const { rows } = await this.client.query<AccountRow>(
      'SELECT id, owner_id, balance FROM payment_schema.accounts WHERE owner_id = $1 ORDER BY id',
      [ownerId],
    );
    return rows.map(toAccount);
  }

  async lockByIds(ids: string[]): Promise<Account[]> {
    // ORDER BY id: todas las transacciones bloquean en el mismo orden → sin deadlocks.
    const { rows } = await this.client.query<AccountRow>(
      'SELECT id, owner_id, balance FROM payment_schema.accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
      [ids],
    );
    return rows.map(toAccount);
  }

  async saveBalance(account: Account): Promise<void> {
    await this.client.query('UPDATE payment_schema.accounts SET balance = $2, updated_at = now() WHERE id = $1', [
      account.id,
      account.balance.toString(),
    ]);
  }
}
