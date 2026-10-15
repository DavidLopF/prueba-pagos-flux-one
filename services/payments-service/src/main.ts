import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CreateTransfer } from './application/CreateTransfer.js';
import { ProcessRailOperations } from './application/ProcessRailOperations.js';
import { TransferQueries } from './application/queries.js';
import { ReverseTransfer } from './application/ReverseTransfer.js';
import { buildApp } from './infrastructure/http/app.js';
import { OutboxRelay } from './infrastructure/messaging/OutboxRelay.js';
import { RabbitMqPublisher } from './infrastructure/messaging/RabbitMqPublisher.js';
import { runMigrations } from './infrastructure/persistence/migrate.js';
import { PgUnitOfWork } from './infrastructure/persistence/PgUnitOfWork.js';
import { HttpBankRail } from './infrastructure/rail/HttpBankRail.js';
import { PollingWorker } from './infrastructure/workers/PollingWorker.js';

/** Composition root: único lugar que conoce todos los adaptadores (CLAUDE.md §1). */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 3002),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtSecret: requireEnv('JWT_SECRET'),
  rabbitUrl: requireEnv('RABBITMQ_URL'),
  railBaseUrl: requireEnv('RAIL_BASE_URL'),
  railTimeoutMs: Number(process.env.RAIL_TIMEOUT_MS ?? 10_000),
};

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
await runMigrations(pool);

const uow = new PgUnitOfWork(pool);
const clock = { now: () => new Date() };
const ids = { newId: () => randomUUID() };

const railProcessor = new ProcessRailOperations(uow, new HttpBankRail(config.railBaseUrl, config.railTimeoutMs), clock, {
  batchSize: 10,
  leaseMs: 3 * config.railTimeoutMs,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 10,
});

const app = buildApp({
  createTransfer: new CreateTransfer(uow, clock, ids),
  reverseTransfer: new ReverseTransfer(uow, clock, ids),
  queries: new TransferQueries(uow),
  jwtSecret: config.jwtSecret,
  onRailWorkQueued: () => railWorker.wake(),
  logger: true,
});
const log = (message: string) => app.log.info(message);
const logError = (error: unknown) => app.log.error(error);

const railWorker = new PollingWorker(1_000, () => railProcessor.runOnce(), logError);
const publisher = new RabbitMqPublisher(config.rabbitUrl, 'payments.events', log);
const relay = new OutboxRelay(pool, publisher);
const outboxWorker = new PollingWorker(500, () => relay.publishPending(), logError);

publisher.start();
railWorker.start();
outboxWorker.start();
await app.listen({ host: '0.0.0.0', port: config.port });

const shutdown = async () => {
  log('Apagando payments-service…');
  await app.close();
  await Promise.all([railWorker.stop(), outboxWorker.stop()]);
  await publisher.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
