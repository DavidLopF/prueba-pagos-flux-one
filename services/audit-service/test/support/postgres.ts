import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { runMigrations } from '../../src/infrastructure/persistence/migrate.js';

// test/support → repository root
const INIT_SQL = new URL('../../../../db/init/01-schemas-and-roles.sql', import.meta.url);

export interface AuditDatabase {
  container: StartedPostgreSqlContainer;
  /** Connected as audit_user, like the service. */
  pool: Pool;
  stop(): Promise<void>;
}

/** Real PostgreSQL bootstrapped exactly like docker-compose, then migrated by the service code. */
export async function startAuditDatabase(): Promise<AuditDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('payments_portal').start();

  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(await readFile(INIT_SQL, 'utf8')); // roles + schemas, as superuser
  await admin.end();

  const pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: 'payments_portal',
    user: 'audit_user',
    password: 'audit_pass',
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
