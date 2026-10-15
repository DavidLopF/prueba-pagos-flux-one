import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

// Same relative depth from src/infrastructure/persistence and dist/infrastructure/persistence.
const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const LOCK_KEY = 'audit_schema';

/**
 * Applies pending migrations/*.sql in lexical order, each one in its own transaction together
 * with its row in schema_migrations. A session advisory lock serialises concurrent replicas.
 * Returns the names of the migrations applied by this call.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_schema.schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM audit_schema.schema_migrations');
    const done = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO audit_schema.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        // Best effort: if the connection itself broke, the original error is the useful one.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    // Destroy instead of returning it to the pool: closing the session releases the advisory
    // lock even if something failed half-way, so it can never leak into a pooled connection.
    client.release(true);
  }
}
