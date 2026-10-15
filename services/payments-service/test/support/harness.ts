import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import jwt from 'jsonwebtoken';
import type pg from 'pg';
import { CreateTransfer } from '../../src/application/CreateTransfer.js';
import { PaymentLinks } from '../../src/application/paymentLinks.js';
import { ProcessRailOperations } from '../../src/application/ProcessRailOperations.js';
import { TransferQueries } from '../../src/application/queries.js';
import { ReverseTransfer } from '../../src/application/ReverseTransfer.js';
import type { BankRail } from '../../src/domain/ports/BankRail.js';
import { buildApp } from '../../src/infrastructure/http/app.js';
import { PgUnitOfWork } from '../../src/infrastructure/persistence/PgUnitOfWork.js';
import { RealtimeHub } from '../../src/infrastructure/realtime/RealtimeHub.js';

export const JWT_SECRET = 'test-secret';

/** Usuarios seed (mismos ids que auth-service). */
export const USERS = {
  alice: '11111111-1111-1111-1111-111111111111', // ACC-001
  bob: '22222222-2222-2222-2222-222222222222', // ACC-002
  carol: '33333333-3333-3333-3333-333333333333', // ACC-003
} as const;

export function tokenFor(userId: string, options: { secret?: string; expiresIn?: number } = {}): string {
  return jwt.sign({ sub: userId, email: `${userId}@demo.co` }, options.secret ?? JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'auth-service',
    audience: 'payments-portal',
    expiresIn: options.expiresIn ?? 900,
  });
}

export interface Harness {
  app: FastifyInstance;
  realtime: RealtimeHub;
  worker: ProcessRailOperations;
  createTransfer(user: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<LightMyRequestResponse>;
  reverse(user: string, transferId: string, idempotencyKey?: string): Promise<LightMyRequestResponse>;
  get(user: string, url: string): Promise<LightMyRequestResponse>;
  /** Ejecuta el worker hasta que no quede trabajo o se agoten los ciclos. */
  drainRail(maxCycles?: number): Promise<void>;
}

export function createHarness(pool: pg.Pool, rail: BankRail): Harness {
  const uow = new PgUnitOfWork(pool);
  const clock = { now: () => new Date() };
  const ids = { newId: () => randomUUID() };
  const realtime = new RealtimeHub();
  const app = buildApp({
    createTransfer: new CreateTransfer(uow, clock, ids),
    reverseTransfer: new ReverseTransfer(uow, clock, ids),
    queries: new TransferQueries(uow),
    paymentLinks: new PaymentLinks(uow, clock, ids),
    realtime,
    jwtSecret: JWT_SECRET,
  });
  // Sin backoff en tests: un reintento queda disponible en el siguiente ciclo.
  const worker = new ProcessRailOperations(uow, rail, clock, {
    batchSize: 20,
    leaseMs: 30_000,
    baseDelayMs: 0,
    maxDelayMs: 0,
    maxAttempts: 5,
  });

  return {
    app,
    realtime,
    worker,
    createTransfer: (user, body, idempotencyKey = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: '/transfers',
        headers: { authorization: `Bearer ${tokenFor(user)}`, 'idempotency-key': idempotencyKey },
        payload: body,
      }),
    reverse: (user, transferId, idempotencyKey = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `/transfers/${transferId}/reversal`,
        headers: { authorization: `Bearer ${tokenFor(user)}`, 'idempotency-key': idempotencyKey },
      }),
    get: (user, url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(user)}` } }),
    async drainRail(maxCycles = 10) {
      for (let cycle = 0; cycle < maxCycles; cycle++) {
        if ((await worker.runOnce()) === 0) return;
      }
    },
  };
}
