import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase, type TestDatabase } from '../support/database.js';

describe('Aislamiento de esquemas (PostgreSQL real)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startDatabase();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('[ARQ-01] el rol de payments solo puede usar payment_schema', async () => {
    await expect(db.pool.query('SELECT count(*) FROM payment_schema.accounts')).resolves.toBeDefined();

    for (const forbidden of ['audit_schema', 'auth_schema']) {
      await expect(db.pool.query(`SELECT 1 FROM ${forbidden}.cualquier_tabla`)).rejects.toThrow(
        `permission denied for schema ${forbidden}`,
      );
    }
    await expect(db.pool.query('CREATE TABLE public.intruso (id int)')).rejects.toThrow(/permission denied/);
  });
});
