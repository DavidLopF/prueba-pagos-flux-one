// Composition root: the only module that knows every adapter.
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { GetTransferAuditHistory } from './application/get-transfer-audit-history.js';
import { RecordAuditEvent } from './application/record-audit-event.js';
import { buildApp } from './infrastructure/http/app.js';
import { JwtAccessTokenVerifier } from './infrastructure/http/jwt-access-token-verifier.js';
import { AuditMessageHandler } from './infrastructure/messaging/audit-message-handler.js';
import { RabbitMqAuditConsumer } from './infrastructure/messaging/rabbitmq-audit-consumer.js';
import { runMigrations } from './infrastructure/persistence/migrate.js';
import { PgAuditEventRepository } from './infrastructure/persistence/pg-audit-event-repository.js';

const env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3003),
    DATABASE_URL: z.string().min(1),
    RABBITMQ_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
  })
  .parse(process.env);

// Fail fast instead of hanging when the database is unreachable (connection) or stuck (statement):
// the consumer processes one delivery at a time, so a hung query would stall it.
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
const repository = new PgAuditEventRepository(pool);

const app = buildApp({
  getTransferAuditHistory: new GetTransferAuditHistory(repository),
  tokenVerifier: new JwtAccessTokenVerifier(env.JWT_SECRET),
  logger: { level: 'info' },
});
const log = app.log;
// An idle pooled client that loses its connection emits 'error'; unhandled, it would kill the process.
pool.on('error', (error) => log.error({ err: error }, 'idle PostgreSQL client error'));

const consumerLog = log.child({ component: 'audit-consumer' });
const consumer = new RabbitMqAuditConsumer({
  url: env.RABBITMQ_URL,
  handler: new AuditMessageHandler(new RecordAuditEvent(repository), consumerLog),
  logger: consumerLog,
});

/** Postgres may still be booting when the container starts: retry the first contact for ~30 s. */
async function migrateWithRetry(attempts = 15, pauseMs = 2_000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await runMigrations(pool);
      log.info({ applied }, 'database migrations up to date');
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      log.warn({ err: error, attempt }, 'database not ready; retrying migrations');
      await delay(pauseMs);
    }
  }
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang on a stuck connection
  try {
    await app.close(); // stop accepting requests, finish in-flight ones
    await consumer.stop(); // finish the delivery in progress, close the AMQP connection
    await pool.end();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await migrateWithRetry();
  consumer.start(); // non-blocking: reconnects in the background while RabbitMQ is down
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  log.fatal({ err: error }, 'audit-service failed to start');
  process.exit(1);
}
