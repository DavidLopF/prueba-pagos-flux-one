import { GetCurrentUser } from '../../src/application/get-current-user.js';
import { Login } from '../../src/application/login.js';
import { Logout } from '../../src/application/logout.js';
import { RefreshSession } from '../../src/application/refresh-session.js';
import { RegisterUser } from '../../src/application/register-user.js';
import { SessionFactory } from '../../src/application/session-factory.js';
import type {
  AccessTokenClaims,
  AccessTokenIssuer,
  Clock,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  TokenGenerator,
  TokenHasher,
  TransactionalRepositories,
  UnitOfWork,
  UserRepository,
} from '../../src/domain/ports.js';
import type { RefreshToken } from '../../src/domain/refresh-token.js';
import type { User } from '../../src/domain/user.js';

// Fakes en memoria de los puertos: permiten probar los casos de uso sin BD, red ni criptografía real.

export class InMemoryUserRepository implements UserRepository {
  private byId = new Map<string, User>();

  constructor(initialUsers: User[] = []) {
    for (const user of initialUsers) this.byId.set(user.id, user);
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.all().find((user) => user.email === email) ?? null;
  }

  async insertIfEmailAvailable(user: User): Promise<boolean> {
    if (this.all().some((existing) => existing.email === user.email)) return false;
    this.byId.set(user.id, user);
    return true;
  }

  all(): User[] {
    return [...this.byId.values()];
  }

  snapshot(): Map<string, User> {
    return new Map(this.byId);
  }

  restore(snapshot: Map<string, User>): void {
    this.byId = new Map(snapshot);
  }
}

export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private byId = new Map<string, RefreshToken>();

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.all().find((token) => token.tokenHash === tokenHash) ?? null;
  }

  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    return this.findByHash(tokenHash);
  }

  async insert(token: RefreshToken): Promise<void> {
    this.byId.set(token.id, token);
  }

  async revoke(id: string, revokedAt: Date, replacedBy: string | null): Promise<boolean> {
    const token = this.byId.get(id);
    if (!token || token.revokedAt !== null) return false;
    this.byId.set(id, { ...token, revokedAt, replacedBy });
    return true;
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    for (const token of this.all()) {
      if (token.userId === userId && token.revokedAt === null) this.byId.set(token.id, { ...token, revokedAt });
    }
  }

  all(): RefreshToken[] {
    return [...this.byId.values()];
  }

  snapshot(): Map<string, RefreshToken> {
    return new Map(this.byId);
  }

  restore(snapshot: Map<string, RefreshToken>): void {
    this.byId = new Map(snapshot);
  }
}

/** Imita la transacción: si `work` lanza, deshace los cambios (como un ROLLBACK). */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(
    private readonly users: InMemoryUserRepository,
    private readonly refreshTokens: InMemoryRefreshTokenRepository,
  ) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    const usersSnapshot = this.users.snapshot();
    const tokensSnapshot = this.refreshTokens.snapshot();
    try {
      return await work({ users: this.users, refreshTokens: this.refreshTokens });
    } catch (error) {
      this.users.restore(usersSnapshot);
      this.refreshTokens.restore(tokensSnapshot);
      throw error;
    }
  }
}

/** "Hash" legible: permite comprobar qué se guardó y contra qué hash se comparó. */
export class FakePasswordHasher implements PasswordHasher {
  readonly verifiedAgainst: string[] = [];

  async hash(plainPassword: string): Promise<string> {
    return `hashed:${plainPassword}`;
  }

  async verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    this.verifiedAgainst.push(passwordHash);
    return passwordHash === `hashed:${plainPassword}`;
  }
}

export class FakeAccessTokenIssuer implements AccessTokenIssuer {
  readonly issued: Array<{ claims: AccessTokenClaims; ttlSeconds: number }> = [];

  issue(claims: AccessTokenClaims, ttlSeconds: number): string {
    this.issued.push({ claims, ttlSeconds });
    return `access-token-${this.issued.length}`;
  }
}

export class SequentialTokenGenerator implements TokenGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    return `refresh-token-${this.counter}`;
  }
}

export class FakeTokenHasher implements TokenHasher {
  hash(token: string): string {
    return `sha256:${token}`;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export const NOW = new Date('2026-01-15T12:00:00.000Z');
export const DUMMY_PASSWORD_HASH = 'hashed:dummy-para-igualar-tiempos';

export const alice: User = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'alice@demo.co',
  passwordHash: 'hashed:Demo1234!',
  createdAt: NOW,
};

/** Casos de uso cableados con fakes, más los fakes para inspeccionar el estado. */
export function createTestContext(initialUsers: User[] = [alice]) {
  const clock = new FixedClock(NOW);
  const ids = new SequentialIdGenerator();
  const users = new InMemoryUserRepository(initialUsers);
  const refreshTokens = new InMemoryRefreshTokenRepository();
  const passwordHasher = new FakePasswordHasher();
  const tokenHasher = new FakeTokenHasher();
  const accessTokens = new FakeAccessTokenIssuer();
  const sessions = new SessionFactory({
    accessTokens,
    tokenGenerator: new SequentialTokenGenerator(),
    tokenHasher,
    ids,
  });

  return {
    clock,
    users,
    refreshTokens,
    passwordHasher,
    accessTokens,
    registerUser: new RegisterUser({ users, passwordHasher, ids, clock }),
    login: new Login({
      users,
      refreshTokens,
      passwordHasher,
      sessions,
      clock,
      dummyPasswordHash: DUMMY_PASSWORD_HASH,
    }),
    refreshSession: new RefreshSession({
      unitOfWork: new InMemoryUnitOfWork(users, refreshTokens),
      tokenHasher,
      sessions,
      clock,
    }),
    logout: new Logout({ refreshTokens, tokenHasher, clock }),
    getCurrentUser: new GetCurrentUser({ users }),
  };
}
