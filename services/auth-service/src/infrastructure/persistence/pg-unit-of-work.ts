import type { Pool } from 'pg';
import type { TransactionalRepositories, UnitOfWork } from '../../domain/ports.js';
import { PgRefreshTokenRepository } from './pg-refresh-token-repository.js';
import { PgUserRepository } from './pg-user-repository.js';

/** Transacción de BD: todos los repositorios que recibe `work` usan la misma conexión (mismo BEGIN/COMMIT). */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query('BEGIN');
      const result = await work({
        users: new PgUserRepository(client),
        refreshTokens: new PgRefreshTokenRepository(client),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Si ni siquiera el ROLLBACK funciona, la conexión está rota: no se devuelve al pool.
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }
}
