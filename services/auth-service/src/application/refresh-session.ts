import { UnauthorizedError } from '../domain/errors.js';
import type { Clock, TokenHasher, UnitOfWork } from '../domain/ports.js';
import { isExpired, isRevoked, wasRotated } from '../domain/refresh-token.js';
import type { SessionFactory, TokenPair } from './session-factory.js';

export interface RefreshSessionInput {
  refreshToken: string;
}

export interface RefreshSessionDeps {
  unitOfWork: UnitOfWork;
  tokenHasher: TokenHasher;
  sessions: SessionFactory;
  clock: Clock;
}

type RotationOutcome = { rotated: true; tokens: TokenPair } | { rotated: false };

const INVALID_REFRESH_TOKEN = 'Refresh token inválido, expirado o revocado';

/** AUTH-05: cambia un refresh token válido por un par nuevo y revoca el anterior (rotación). */
export class RefreshSession {
  constructor(private readonly deps: RefreshSessionDeps) {}

  async execute(input: RefreshSessionInput): Promise<TokenPair> {
    const tokenHash = this.deps.tokenHasher.hash(input.refreshToken);

    const outcome = await this.deps.unitOfWork.run(async ({ users, refreshTokens }): Promise<RotationOutcome> => {
      const now = this.deps.clock.now();
      // Bloquea la fila: dos refresh simultáneos con el mismo token se serializan y el segundo lo ve ya rotado.
      const current = await refreshTokens.findByHashForUpdate(tokenHash);
      if (!current) {
        return { rotated: false };
      }
      if (isRevoked(current)) {
        if (wasRotated(current)) {
          // Detección de reutilización: alguien más tiene una copia de un token ya rotado (posible robo).
          // Se revocan todas las sesiones activas del usuario, incluida la del posible atacante.
          await refreshTokens.revokeAllForUser(current.userId, now);
        }
        return { rotated: false };
      }
      if (isExpired(current, now)) {
        return { rotated: false };
      }
      const user = await users.findById(current.userId);
      if (!user) {
        return { rotated: false };
      }

      const session = this.deps.sessions.create(user, now);
      await refreshTokens.insert(session.refreshTokenRecord);
      const revoked = await refreshTokens.revoke(current.id, now, session.refreshTokenRecord.id);
      if (!revoked) {
        // No debería pasar (la fila está bloqueada); si pasa, lanzar hace rollback del token recién insertado.
        throw new UnauthorizedError(INVALID_REFRESH_TOKEN);
      }
      return { rotated: true, tokens: session.tokens };
    });

    // El 401 se lanza después del commit: lanzarlo dentro de la transacción desharía la revocación por reutilización.
    if (!outcome.rotated) {
      throw new UnauthorizedError(INVALID_REFRESH_TOKEN);
    }
    return outcome.tokens;
  }
}
