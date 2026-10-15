import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

// Misma profundidad desde src/ (tsx/vitest) y desde dist/ (producción): apunta a <servicio>/migrations.
const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const SCHEMA = 'payment_schema';

/** Aplica en orden los .sql pendientes, cada uno en su transacción. El advisory lock evita carreras entre réplicas. */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [SCHEMA]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ name: string }>(`SELECT name FROM ${SCHEMA}.schema_migrations`);
    const done = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${SCHEMA}.schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SCHEMA]).catch(() => undefined);
    client.release();
  }
}
