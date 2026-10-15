import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from '../../src/infrastructure/persistence/migrate.js';

// test/support → raíz del repo: reutilizamos el mismo script de esquemas y roles que docker compose.
const INIT_SQL = new URL('../../../../db/init/01-schemas-and-roles.sql', import.meta.url);

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Conectado como payments_user: el mismo rol (y permisos) que usa el servicio. */
  pool: pg.Pool;
  stop(): Promise<void>;
}

export async function startDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('payments_portal').start();
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(await readFile(INIT_SQL, 'utf8'));
  await admin.end();

  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: 'payments_portal',
    user: 'payments_user',
    password: 'payments_pass',
    max: 30,
  });
  await runMigrations(pool);
  return {
    container,
    pool,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

/** Vuelve a los datos iniciales de la spec entre tests. */
export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE payment_schema.outbox, payment_schema.idempotency_keys, payment_schema.transfers');
  await pool.query(`UPDATE payment_schema.accounts
                       SET balance = CASE id WHEN 'ACC-001' THEN 1000000.00 WHEN 'ACC-002' THEN 500000.00 ELSE 0 END`);
}

export async function balanceOf(pool: pg.Pool, accountId: string): Promise<string> {
  const { rows } = await pool.query<{ balance: string }>(
    'SELECT balance FROM payment_schema.accounts WHERE id = $1',
    [accountId],
  );
  return rows[0]!.balance;
}

export async function countRows(pool: pg.Pool, table: 'transfers' | 'outbox' | 'idempotency_keys'): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM payment_schema.${table}`);
  return Number(rows[0]!.count);
}
