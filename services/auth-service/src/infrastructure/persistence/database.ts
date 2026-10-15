import { setTimeout as sleep } from 'node:timers/promises';
import pg, { type Pool } from 'pg';

/** Lo mínimo que necesita un repositorio: un Pool (consultas sueltas) o un PoolClient (dentro de una transacción). */
export type Queryable = Pick<Pool, 'query'>;

/** El rol del servicio (auth_user) solo tiene privilegios sobre auth_schema (CLAUDE.md §1). */
export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Espera a que PostgreSQL acepte conexiones antes de migrar: en docker compose el servicio puede arrancar antes
 * que la base de datos.
 */
export async function waitForDatabase(
  pool: Pool,
  onRetry: (attempt: number, error: unknown) => void,
  maxAttempts = 30,
  delayMs = 1_000,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      onRetry(attempt, error);
      await sleep(delayMs);
    }
  }
}
