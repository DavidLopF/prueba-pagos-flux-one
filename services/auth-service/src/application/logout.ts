import type { Clock, RefreshTokenRepository, TokenHasher } from '../domain/ports.js';
import { isRevoked } from '../domain/refresh-token.js';

export interface LogoutInput {
  refreshToken: string;
}

export interface LogoutDeps {
  refreshTokens: RefreshTokenRepository;
  tokenHasher: TokenHasher;
  clock: Clock;
}

/** AUTH-05: revoca el refresh token actual. Idempotente: un token desconocido o ya revocado no es un error. */
export class Logout {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(input: LogoutInput): Promise<void> {
    const token = await this.deps.refreshTokens.findByHash(this.deps.tokenHasher.hash(input.refreshToken));
    if (token && !isRevoked(token)) {
      await this.deps.refreshTokens.revoke(token.id, this.deps.clock.now(), null);
    }
  }
}
