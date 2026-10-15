import type { RefreshToken } from './refresh-token.js';
import type { User } from './user.js';

// Puertos: lo que la aplicación necesita del mundo exterior. Los adaptadores viven en infrastructure/.

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /** Recibe el email ya normalizado. */
  findByEmail(email: string): Promise<User | null>;
  /** Inserta el usuario; devuelve false si el email ya existía (la unicidad la garantiza la BD, también en concurrencia). */
  insertIfEmailAvailable(user: User): Promise<boolean>;
}

export interface RefreshTokenRepository {
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  /** Igual que findByHash pero bloquea la fila hasta el fin de la transacción en curso (rotación concurrente). */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>;
  insert(token: RefreshToken): Promise<void>;
  /** Revoca solo si sigue activo (revokedAt nulo). Devuelve false si ya estaba revocado. */
  revoke(id: string, revokedAt: Date, replacedBy: string | null): Promise<boolean>;
  /** Revoca todos los tokens aún no revocados del usuario. */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
}

export interface TransactionalRepositories {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
}

export interface UnitOfWork {
  /** Ejecuta `work` en una transacción: commit si resuelve, rollback si lanza. */
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export interface PasswordHasher {
  hash(plainPassword: string): Promise<string>;
  verify(plainPassword: string, passwordHash: string): Promise<boolean>;
}

export interface AccessTokenClaims {
  userId: string;
  email: string;
}

export interface AccessTokenIssuer {
  issue(claims: AccessTokenClaims, ttlSeconds: number): string;
}

export interface AccessTokenVerifier {
  /** Devuelve los claims del token o lanza UnauthorizedError (firma inválida, vencido, emisor/audiencia incorrectos…). */
  verify(token: string): AccessTokenClaims;
}

/** Genera valores aleatorios opacos (refresh tokens). */
export interface TokenGenerator {
  generate(): string;
}

/** Hash determinista para buscar refresh tokens sin guardarlos en claro. */
export interface TokenHasher {
  hash(token: string): string;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
