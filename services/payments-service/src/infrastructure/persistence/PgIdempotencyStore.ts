import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdempotencyCheck, IdempotencyStore } from '../../domain/ports/repositories.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: PoolClient) {}

  async begin(ownerId: string, key: string, fingerprint: string): Promise<IdempotencyCheck> {
    const requestHash = sha256(fingerprint);
    // Si otra transacción ya insertó esta key y no ha terminado, este INSERT ESPERA a que haga
    // commit/rollback: así los reintentos concurrentes se serializan sin locks explícitos.
    const inserted = await this.client.query(
      `INSERT INTO payment_schema.idempotency_keys (owner_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO NOTHING`,
      [ownerId, key, requestHash],
    );
    if (inserted.rowCount === 1) {
      return { kind: 'NEW' };
    }
    const { rows } = await this.client.query<{ request_hash: string; response_body: unknown }>(
      'SELECT request_hash, response_body FROM payment_schema.idempotency_keys WHERE owner_id = $1 AND key = $2',
      [ownerId, key],
    );
    const existing = rows[0];
    if (!existing || existing.response_body === null) {
      throw new Error('Registro de idempotencia inconsistente');
    }
    return existing.request_hash === requestHash
      ? { kind: 'REPLAY', response: existing.response_body }
      : { kind: 'MISMATCH' };
  }

  async complete(ownerId: string, key: string, response: unknown): Promise<void> {
    await this.client.query(
      'UPDATE payment_schema.idempotency_keys SET response_body = $3::jsonb WHERE owner_id = $1 AND key = $2',
      [ownerId, key, JSON.stringify(response)],
    );
  }
}
