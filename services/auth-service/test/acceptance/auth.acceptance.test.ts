import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GetCurrentUser } from '../../src/application/get-current-user.js';
import { Login } from '../../src/application/login.js';
import { Logout } from '../../src/application/logout.js';
import { RefreshSession } from '../../src/application/refresh-session.js';
import { RegisterUser } from '../../src/application/register-user.js';
import { SessionFactory } from '../../src/application/session-factory.js';
import { buildApp } from '../../src/infrastructure/http/app.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrate.js';
import { PgRefreshTokenRepository } from '../../src/infrastructure/persistence/pg-refresh-token-repository.js';
import { PgUnitOfWork } from '../../src/infrastructure/persistence/pg-unit-of-work.js';
import { PgUserRepository } from '../../src/infrastructure/persistence/pg-user-repository.js';
import { BcryptPasswordHasher } from '../../src/infrastructure/security/bcrypt-password-hasher.js';
import { JwtAccessTokenIssuer, JwtAccessTokenVerifier } from '../../src/infrastructure/security/jwt-access-tokens.js';
import { CryptoTokenGenerator, Sha256TokenHasher } from '../../src/infrastructure/security/opaque-tokens.js';
import { SystemClock } from '../../src/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/infrastructure/system/uuid-generator.js';

/** El mismo script que usa docker compose para crear roles y esquemas (raíz del repo). */
const INIT_SQL = new URL('../../../../db/init/01-schemas-and-roles.sql', import.meta.url);
const JWT_SECRET = 'secreto-de-pruebas-de-aceptacion-32-caracteres';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('payments_portal').start();

  // 1) Como superusuario: roles y esquemas por servicio, exactamente como en docker compose.
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(await readFile(INIT_SQL, 'utf8'));
  await admin.end();

  // 2) Como auth_user, que solo tiene permisos sobre auth_schema (igual que el servicio en producción).
  pool = new pg.Pool({
    connectionString: `postgres://auth_user:auth_pass@${container.getHost()}:${container.getPort()}/payments_portal`,
  });
  await runMigrations(pool);
  app = await buildRealApp(pool);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

/** Mismo cableado que src/main.ts, con todos los adaptadores reales. */
async function buildRealApp(db: pg.Pool): Promise<FastifyInstance> {
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const tokenHasher = new Sha256TokenHasher();
  const passwordHasher = new BcryptPasswordHasher();
  const users = new PgUserRepository(db);
  const refreshTokens = new PgRefreshTokenRepository(db);
  const sessions = new SessionFactory({
    accessTokens: new JwtAccessTokenIssuer(JWT_SECRET),
    tokenGenerator: new CryptoTokenGenerator(),
    tokenHasher,
    ids,
  });
  const dummyPasswordHash = await passwordHasher.hash(randomUUID());
  return buildApp({
    registerUser: new RegisterUser({ users, passwordHasher, ids, clock }),
    login: new Login({ users, refreshTokens, passwordHasher, sessions, clock, dummyPasswordHash }),
    refreshSession: new RefreshSession({ unitOfWork: new PgUnitOfWork(db), tokenHasher, sessions, clock }),
    logout: new Logout({ refreshTokens, tokenHasher, clock }),
    getCurrentUser: new GetCurrentUser({ users }),
    accessTokenVerifier: new JwtAccessTokenVerifier(JWT_SECRET),
  });
}

function post(url: string, payload: object) {
  return app.inject({ method: 'POST', url, payload });
}

function getMe(authorization?: string) {
  return app.inject({ method: 'GET', url: '/auth/me', headers: authorization ? { authorization } : {} });
}

async function registerOk(email: string, password: string): Promise<void> {
  const response = await post('/auth/register', { email, password });
  expect(response.statusCode).toBe(201);
}

async function loginOk(email: string, password: string): Promise<TokenPairBody> {
  const response = await post('/auth/login', { email, password });
  expect(response.statusCode).toBe(200);
  return response.json<TokenPairBody>();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

it('[AUTH-01] POST /auth/register crea el usuario (201) y guarda la contraseña solo como hash bcrypt', async () => {
  const response = await post('/auth/register', { email: 'Dave@Demo.co', password: 'Secreta123' });

  expect(response.statusCode).toBe(201);
  const body = response.json<{ id: string; email: string }>();
  expect(body).toEqual({ id: expect.stringMatching(UUID_PATTERN), email: 'dave@demo.co' });
  const { rows } = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM auth_schema.users WHERE id = $1',
    [body.id],
  );
  expect(rows[0]?.password_hash).toMatch(/^\$2b\$10\$/);
  expect(rows[0]?.password_hash).not.toContain('Secreta123');
});

it('[AUTH-01] POST /auth/register con un email ya registrado (otra capitalización) → 409 EMAIL_TAKEN', async () => {
  const response = await post('/auth/register', { email: 'ALICE@demo.co', password: 'OtraClave123' });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code: 'EMAIL_TAKEN', message: expect.any(String) });
});

it('[AUTH-01] POST /auth/register con contraseña de menos de 8 caracteres, email inválido o campos faltantes → 400', async () => {
  const invalidBodies = [
    { email: 'eve@demo.co', password: '1234567' },
    { email: 'no-es-un-email', password: 'Secreta123' },
    { email: 'eve@demo.co' },
  ];
  for (const payload of invalidBodies) {
    const response = await post('/auth/register', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'VALIDATION_ERROR', message: expect.any(String) });
  }
});

it('[AUTH-02] alice@demo.co (seed) hace login y recibe un JWT HS256 de 15 min con sub = su id y un refresh token', async () => {
  const response = await post('/auth/login', { email: 'alice@demo.co', password: 'Demo1234!' });

  expect(response.statusCode).toBe(200);
  const body = response.json<TokenPairBody>();
  expect(body).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
  // Exactamente como lo verificarán payments-service y audit-service.
  const claims = jwt.verify(body.accessToken, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: 'auth-service',
    audience: 'payments-portal',
  });
  expect(claims).toMatchObject({ sub: '11111111-1111-1111-1111-111111111111', email: 'alice@demo.co' });
  // El refresh token solo se persiste como hash SHA-256, nunca en claro.
  const stored = await pool.query('SELECT 1 FROM auth_schema.refresh_tokens WHERE token_hash = $1', [
    sha256(body.refreshToken),
  ]);
  expect(stored.rowCount).toBe(1);
  const plain = await pool.query('SELECT 1 FROM auth_schema.refresh_tokens WHERE token_hash = $1', [body.refreshToken]);
  expect(plain.rowCount).toBe(0);
});

it('[AUTH-02] los tres usuarios seed inician sesión con Demo1234! y GET /auth/me devuelve sus ids fijos', async () => {
  const seedUsers = [
    { id: '11111111-1111-1111-1111-111111111111', email: 'alice@demo.co' },
    { id: '22222222-2222-2222-2222-222222222222', email: 'bob@demo.co' },
    { id: '33333333-3333-3333-3333-333333333333', email: 'carol@demo.co' },
  ];
  for (const seed of seedUsers) {
    const { accessToken } = await loginOk(seed.email, 'Demo1234!');
    const me = await getMe(`Bearer ${accessToken}`);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(seed);
  }
});

it('[AUTH-02] GET /auth/me sin token, con otro esquema, con firma inválida o vencido → 401 UNAUTHORIZED', async () => {
  const bob = { subject: '22222222-2222-2222-2222-222222222222', issuer: 'auth-service', audience: 'payments-portal' };
  const forged = jwt.sign({ email: 'bob@demo.co' }, 'secreto-de-un-atacante-con-32-caracteres', {
    ...bob,
    algorithm: 'HS256',
    expiresIn: 900,
  });
  const expired = jwt.sign({ email: 'bob@demo.co' }, JWT_SECRET, { ...bob, algorithm: 'HS256', expiresIn: -10 });

  for (const authorization of [undefined, 'Basic Ym9iOkRlbW8xMjM0IQ==', `Bearer ${forged}`, `Bearer ${expired}`]) {
    const response = await getMe(authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) });
  }
});

it('[AUTH-03] contraseña errónea y email inexistente → 401 INVALID_CREDENTIALS con el mismo cuerpo', async () => {
  const wrongPassword = await post('/auth/login', { email: 'alice@demo.co', password: 'Incorrecta1' });
  const unknownEmail = await post('/auth/login', { email: 'nadie@demo.co', password: 'Demo1234!' });

  expect(wrongPassword.statusCode).toBe(401);
  expect(unknownEmail.statusCode).toBe(401);
  expect(wrongPassword.json()).toEqual({ code: 'INVALID_CREDENTIALS', message: expect.any(String) });
  expect(unknownEmail.json()).toEqual(wrongPassword.json());
});

it('[AUTH-05] POST /auth/refresh entrega un par nuevo y revoca el anterior; reutilizar el anterior → 401 y cierra la sesión', async () => {
  await registerOk('rotacion@demo.co', 'Secreta123');
  const first = await loginOk('rotacion@demo.co', 'Secreta123');

  const refreshed = await post('/auth/refresh', { refreshToken: first.refreshToken });
  expect(refreshed.statusCode).toBe(200);
  const second = refreshed.json<TokenPairBody>();
  expect(second).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect((await getMe(`Bearer ${second.accessToken}`)).statusCode).toBe(200);

  // En BD el anterior quedó revocado y apuntando a su reemplazo.
  const { rows } = await pool.query(
    `SELECT previous.revoked_at IS NOT NULL AS revoked, previous.replaced_by = current.id AS points_to_new
     FROM auth_schema.refresh_tokens previous, auth_schema.refresh_tokens current
     WHERE previous.token_hash = $1 AND current.token_hash = $2`,
    [sha256(first.refreshToken), sha256(second.refreshToken)],
  );
  expect(rows).toEqual([{ revoked: true, points_to_new: true }]);

  // Reutilizar el anterior → 401…
  const reuse = await post('/auth/refresh', { refreshToken: first.refreshToken });
  expect(reuse.statusCode).toBe(401);
  expect(reuse.json()).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) });
  // …y la detección de reutilización revocó también el refresh token vigente.
  expect((await post('/auth/refresh', { refreshToken: second.refreshToken })).statusCode).toBe(401);
});

it('[AUTH-05] dos POST /auth/refresh simultáneos con el mismo token: solo uno rota, el otro recibe 401', async () => {
  await registerOk('concurrente@demo.co', 'Secreta123');
  const { refreshToken } = await loginOk('concurrente@demo.co', 'Secreta123');

  const responses = await Promise.all([
    post('/auth/refresh', { refreshToken }),
    post('/auth/refresh', { refreshToken }),
  ]);

  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  // Solo se emitió un token de reemplazo: el del login más el de la única rotación.
  const { rows } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM auth_schema.refresh_tokens t
     JOIN auth_schema.users u ON u.id = t.user_id WHERE u.email = $1`,
    ['concurrente@demo.co'],
  );
  expect(rows[0]?.total).toBe(2);
});

it('[AUTH-05] POST /auth/logout revoca el refresh token actual (204) y es idempotente', async () => {
  await registerOk('logout@demo.co', 'Secreta123');
  const { refreshToken } = await loginOk('logout@demo.co', 'Secreta123');

  const logout = await post('/auth/logout', { refreshToken });
  expect(logout.statusCode).toBe(204);
  expect(logout.body).toBe('');

  expect((await post('/auth/refresh', { refreshToken })).statusCode).toBe(401);
  expect((await post('/auth/logout', { refreshToken })).statusCode).toBe(204);
  expect((await post('/auth/logout', { refreshToken: 'token-desconocido' })).statusCode).toBe(204);
});
