// Composition root: el único lugar que conoce todos los adaptadores (CLAUDE.md §1).
import { randomUUID } from 'node:crypto';
import { GetCurrentUser } from './application/get-current-user.js';
import { Login } from './application/login.js';
import { Logout } from './application/logout.js';
import { RefreshSession } from './application/refresh-session.js';
import { RegisterUser } from './application/register-user.js';
import { SessionFactory } from './application/session-factory.js';
import { buildApp } from './infrastructure/http/app.js';
import { createPool, waitForDatabase } from './infrastructure/persistence/database.js';
import { runMigrations } from './infrastructure/persistence/migrate.js';
import { PgRefreshTokenRepository } from './infrastructure/persistence/pg-refresh-token-repository.js';
import { PgUnitOfWork } from './infrastructure/persistence/pg-unit-of-work.js';
import { PgUserRepository } from './infrastructure/persistence/pg-user-repository.js';
import { BcryptPasswordHasher } from './infrastructure/security/bcrypt-password-hasher.js';
import { JwtAccessTokenIssuer, JwtAccessTokenVerifier } from './infrastructure/security/jwt-access-tokens.js';
import { CryptoTokenGenerator, Sha256TokenHasher } from './infrastructure/security/opaque-tokens.js';
import { SystemClock } from './infrastructure/system/system-clock.js';
import { UuidGenerator } from './infrastructure/system/uuid-generator.js';

interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  logLevel: string;
}

function loadConfig(env: NodeJS.ProcessEnv): Config {
  const { DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret } = env;
  if (!databaseUrl) {
    throw new Error('Falta la variable de entorno DATABASE_URL');
  }
  if (!jwtSecret) {
    throw new Error('Falta la variable de entorno JWT_SECRET');
  }
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT inválido: ${env.PORT}`);
  }
  return { port, databaseUrl, jwtSecret, logLevel: env.LOG_LEVEL ?? 'info' };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);

  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const tokenHasher = new Sha256TokenHasher();
  const passwordHasher = new BcryptPasswordHasher();
  const users = new PgUserRepository(pool);
  const refreshTokens = new PgRefreshTokenRepository(pool);
  const sessions = new SessionFactory({
    accessTokens: new JwtAccessTokenIssuer(config.jwtSecret),
    tokenGenerator: new CryptoTokenGenerator(),
    tokenHasher,
    ids,
  });
  // Hash señuelo (mismo coste bcrypt que los reales): el login con un email inexistente compara contra él para
  // tardar lo mismo que con una contraseña errónea (AUTH-03).
  const dummyPasswordHash = await passwordHasher.hash(randomUUID());

  const app = buildApp(
    {
      registerUser: new RegisterUser({ users, passwordHasher, ids, clock }),
      login: new Login({ users, refreshTokens, passwordHasher, sessions, clock, dummyPasswordHash }),
      refreshSession: new RefreshSession({ unitOfWork: new PgUnitOfWork(pool), tokenHasher, sessions, clock }),
      logout: new Logout({ refreshTokens, tokenHasher, clock }),
      getCurrentUser: new GetCurrentUser({ users }),
      accessTokenVerifier: new JwtAccessTokenVerifier(config.jwtSecret),
    },
    {
      // Los serializers por defecto de Fastify solo registran método, URL y status (ni headers ni bodies);
      // el redact es una red de seguridad para que el Bearer token nunca termine en los logs (CLAUDE.md §6).
      logger: { level: config.logLevel, redact: ['req.headers.authorization'] },
    },
  );

  if (config.jwtSecret.length < 32) {
    app.log.warn('JWT_SECRET tiene menos de 32 caracteres; para HS256 se recomiendan al menos 256 bits');
  }
  // Sin este listener, un error en una conexión inactiva del pool (p. ej. reinicio de PostgreSQL) tumbaría el proceso.
  pool.on('error', (error) => app.log.error({ err: error }, 'Error en una conexión inactiva de PostgreSQL'));

  await waitForDatabase(pool, (attempt) => app.log.warn({ attempt }, 'PostgreSQL aún no acepta conexiones; reintentando'));
  const applied = await runMigrations(pool);
  app.log.info({ applied }, 'Migraciones al día');

  await app.listen({ host: '0.0.0.0', port: config.port });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Apagando auth-service');
    try {
      await app.close(); // deja de aceptar conexiones y espera a que terminen las peticiones en curso
      await pool.end();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error durante el apagado');
      process.exit(1);
    }
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  console.error('auth-service no pudo arrancar:', error);
  process.exit(1);
});
