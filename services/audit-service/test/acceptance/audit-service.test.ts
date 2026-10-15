import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetTransferAuditHistory } from '../../src/application/get-transfer-audit-history.js';
import { RecordAuditEvent } from '../../src/application/record-audit-event.js';
import { parseAuditEvent } from '../../src/domain/audit-event.js';
import { InvalidAuditEventError } from '../../src/domain/errors.js';
import { buildApp } from '../../src/infrastructure/http/app.js';
import { JwtAccessTokenVerifier } from '../../src/infrastructure/http/jwt-access-token-verifier.js';
import { PgAuditEventRepository } from '../../src/infrastructure/persistence/pg-audit-event-repository.js';
import { ALICE, BOB, CAROL, transferEvent } from '../support/fixtures.js';
import { startAuditDatabase, type AuditDatabase } from '../support/postgres.js';

const JWT_SECRET = 'test-secret';

function accessToken(userId: string, overrides: { secret?: string; expiresIn?: number; issuer?: string } = {}) {
  return jwt.sign({ email: `${userId}@demo.co` }, overrides.secret ?? JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: overrides.issuer ?? 'auth-service',
    audience: 'payments-portal',
    expiresIn: overrides.expiresIn ?? 900,
  });
}

describe('audit-service con PostgreSQL real', () => {
  let db: AuditDatabase;
  let repository: PgAuditEventRepository;
  let record: RecordAuditEvent;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startAuditDatabase();
    repository = new PgAuditEventRepository(db.pool);
    record = new RecordAuditEvent(repository);
    app = buildApp({
      getTransferAuditHistory: new GetTransferAuditHistory(repository),
      tokenVerifier: new JwtAccessTokenVerifier(JWT_SECRET),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  const getHistory = (transferId: string, token?: string) =>
    app.inject({
      method: 'GET',
      url: `/audit/transfers/${transferId}/events`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  describe('PgAuditEventRepository', () => {
    it('[AUD-04] el mismo evento guardado dos veces deja una sola fila', async () => {
      const event = parseAuditEvent(transferEvent());

      expect(await repository.saveIfAbsent(event)).toBe(true);
      expect(await repository.saveIfAbsent(event)).toBe(false);

      const { rows } = await db.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM audit_schema.audit_events WHERE event_id = $1',
        [event.eventId],
      );
      expect(rows[0]?.count).toBe(1);
    });

    it('[AUD-06] datos que PostgreSQL rechaza se reportan como evento inválido (DLQ), no como fallo transitorio', async () => {
      const message = transferEvent();
      const event = parseAuditEvent({ ...message, payload: { ...message.payload, note: 'nul \u0000 byte' } });

      await expect(repository.saveIfAbsent(event)).rejects.toThrow(InvalidAuditEventError);
    });
  });

  describe('GET /audit/transfers/{id}/events', () => {
    it('[AUD-05] devuelve los eventos de una transferencia propia ordenados por occurredAt ascendente', async () => {
      const transferId = randomUUID();
      const created = transferEvent({ transferId, eventType: 'TRANSFER_CREATED', status: 'COMPLETED', occurredAt: '2026-10-15T10:00:00.000Z' });
      const requested = transferEvent({ transferId, eventType: 'TRANSFER_REVERSAL_REQUESTED', status: 'REVERSAL_PENDING', occurredAt: '2026-10-15T10:05:00.000Z' });
      const reversed = transferEvent({ transferId, eventType: 'TRANSFER_REVERSED', status: 'REVERSED', occurredAt: '2026-10-15T10:05:00.000Z', actorId: null });
      // Arrival order ≠ occurrence order; equal occurredAt is resolved by arrival (received_at).
      await record.execute(requested);
      await record.execute(created);
      await record.execute(reversed);

      const response = await getHistory(transferId, accessToken(ALICE));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          eventId: created.eventId,
          transferId,
          eventType: 'TRANSFER_CREATED',
          status: 'COMPLETED',
          actorId: ALICE,
          occurredAt: '2026-10-15T10:00:00.000Z',
          payload: created.payload,
        },
        expect.objectContaining({ eventId: requested.eventId, eventType: 'TRANSFER_REVERSAL_REQUESTED', status: 'REVERSAL_PENDING' }),
        expect.objectContaining({ eventId: reversed.eventId, eventType: 'TRANSFER_REVERSED', status: 'REVERSED', actorId: null }),
      ]);
    });

    it('[AUD-05] solo ve los eventos quien participa en la transferencia; ajena o inexistente → 200 []', async () => {
      const transferId = randomUUID();
      await record.execute(transferEvent({ transferId, participantIds: [ALICE, BOB] }));

      const asBob = await getHistory(transferId, accessToken(BOB));
      const asCarol = await getHistory(transferId, accessToken(CAROL));
      const unknown = await getHistory(randomUUID(), accessToken(ALICE));

      expect(asBob.json()).toHaveLength(1);
      expect(asBob.json()[0]).not.toHaveProperty('participantIds');
      expect([asCarol.statusCode, asCarol.json()]).toEqual([200, []]);
      expect([unknown.statusCode, unknown.json()]).toEqual([200, []]);
    });

    it('[AUD-05] un id que no es UUID responde 400 VALIDATION_ERROR', async () => {
      const response = await getHistory('not-a-uuid', accessToken(ALICE));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'VALIDATION_ERROR', message: expect.any(String) });
    });
  });

  describe('aislamiento de esquemas', () => {
    it('[ARQ-01] audit_user no puede leer otros esquemas ni crear objetos en public', async () => {
      const forbidden = [
        'SELECT 1 FROM payment_schema.outbox',
        'SELECT 1 FROM auth_schema.users',
        'CREATE TABLE public.intruder (id int)',
      ];

      for (const sql of forbidden) {
        await expect(db.pool.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe('autenticación', () => {
    it('[AUTH-04] sin Authorization: Bearer responde 401 UNAUTHORIZED', async () => {
      for (const headers of [{}, { authorization: 'Basic YWxpY2U6eA==' }, { authorization: 'Bearer' }]) {
        const response = await app.inject({ method: 'GET', url: `/audit/transfers/${randomUUID()}/events`, headers });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) });
      }
    });

    it('[AUTH-04] token vencido, con firma inválida, de otro emisor o sin firma responde 401 UNAUTHORIZED', async () => {
      const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: ALICE, iss: 'auth-service', aud: 'payments-portal' })}.`;
      const badTokens = [
        accessToken(ALICE, { expiresIn: -60 }),
        accessToken(ALICE, { secret: 'another-secret' }),
        accessToken(ALICE, { issuer: 'someone-else' }),
        unsigned,
      ];

      for (const token of badTokens) {
        const response = await getHistory(randomUUID(), token);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) });
      }
    });

    it('[AUTH-04] /health no requiere token y cualquier otra ruta sí', async () => {
      const health = await app.inject({ method: 'GET', url: '/health' });
      const unknownRoute = await app.inject({ method: 'GET', url: '/audit/whatever' });

      expect([health.statusCode, health.json()]).toEqual([200, { status: 'ok' }]);
      expect(unknownRoute.statusCode).toBe(401);
    });
  });
});
