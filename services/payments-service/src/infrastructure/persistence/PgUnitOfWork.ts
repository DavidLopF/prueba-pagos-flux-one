import type { Pool } from 'pg';
import type { TransactionContext, UnitOfWork } from '../../domain/ports/repositories.js';
import { PgAccountRepository } from './PgAccountRepository.js';
import { PgIdempotencyStore } from './PgIdempotencyStore.js';
import { PgOutbox } from './PgOutbox.js';
import { PgTransferRepository } from './PgTransferRepository.js';

/** Una transacción por llamada a run(); todos los repositorios comparten la misma conexión. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        accounts: new PgAccountRepository(client),
        transfers: new PgTransferRepository(client),
        idempotency: new PgIdempotencyStore(client),
        outbox: new PgOutbox(client),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
