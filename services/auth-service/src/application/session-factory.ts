import type { AccessTokenIssuer, IdGenerator, TokenGenerator, TokenHasher } from '../domain/ports.js';
import type { RefreshToken } from '../domain/refresh-token.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_MS } from '../domain/session-policy.js';
import type { User } from '../domain/user.js';

/** Respuesta de login y refresh (schema `TokenPair` del contrato). */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface NewSession {
  /** Fila a persistir: solo lleva el hash del refresh token. */
  refreshTokenRecord: RefreshToken;
  /** Lo que recibe el cliente: el refresh token en claro solo existe aquí. */
  tokens: TokenPair;
}

export interface SessionFactoryDeps {
  accessTokens: AccessTokenIssuer;
  tokenGenerator: TokenGenerator;
  tokenHasher: TokenHasher;
  ids: IdGenerator;
}

/**
 * Arma un par de tokens nuevo para un usuario (lo usan Login y RefreshSession).
 * No persiste nada: cada caso de uso guarda `refreshTokenRecord` con el repositorio que corresponda
 * (RefreshSession lo hace dentro de su transacción de rotación).
 */
export class SessionFactory {
  constructor(private readonly deps: SessionFactoryDeps) {}

  create(user: Pick<User, 'id' | 'email'>, now: Date): NewSession {
    const refreshToken = this.deps.tokenGenerator.generate();
    const refreshTokenRecord: RefreshToken = {
      id: this.deps.ids.next(),
      userId: user.id,
      tokenHash: this.deps.tokenHasher.hash(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      revokedAt: null,
      replacedBy: null,
      createdAt: now,
    };
    const accessToken = this.deps.accessTokens.issue({ userId: user.id, email: user.email }, ACCESS_TOKEN_TTL_SECONDS);
    return {
      refreshTokenRecord,
      tokens: { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    };
  }
}
