import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

/** Carpeta migrations/ del servicio. La profundidad es la misma desde src/ (tsx) y desde dist/ (build). */
const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

/** Clave del advisory lock: dos réplicas arrancando a la vez no aplican las migraciones dos veces. */
const LOCK_KEY = 'auth_schema';

/**
 * Aplica, en orden lexicográfico, los .sql de migrations/ que aún no figuran en auth_schema.schema_migrations.
 * Cada archivo corre en su propia transacción junto con su registro en schema_migrations.
 * El esquema auth_schema ya existe (db/init lo crea); aquí solo se crean tablas dentro de él.
 * Devuelve los nombres de las migraciones aplicadas en esta ejecución.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    const applied = await applyPendingMigrations(client);
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    client.release();
    return applied;
  } catch (error) {
    // Se descarta la conexión: al cerrarse la sesión, PostgreSQL hace rollback de la transacción abierta
    // y libera el advisory lock.
    client.release(true);
    throw error;
  }
}

async function applyPendingMigrations(client: PoolClient): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS auth_schema.schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await client.query<{ name: string }>('SELECT name FROM auth_schema.schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) {
      continue;
    }
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO auth_schema.schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    applied.push(file);
  }
  return applied;
}
