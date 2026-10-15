import jwt, { type JwtPayload } from 'jsonwebtoken';
import { UnauthorizedError } from '../../domain/errors.js';
import type { AccessTokenClaims, AccessTokenIssuer, AccessTokenVerifier } from '../../domain/ports.js';

// payments-service y audit-service verifican con exactamente estos valores (CLAUDE.md §6).
const JWT_ISSUER = 'auth-service';
const JWT_AUDIENCE = 'payments-portal';
const JWT_ALGORITHM = 'HS256';

const INVALID_TOKEN_MESSAGE = 'Access token inválido o vencido';

/** Firma access tokens JWT HS256 con el secreto compartido. Claims: `sub` = id de usuario, `email`. */
export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  constructor(private readonly secret: string) {}

  issue(claims: AccessTokenClaims, ttlSeconds: number): string {
    return jwt.sign({ email: claims.email }, this.secret, {
      algorithm: JWT_ALGORITHM,
      subject: claims.userId,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: ttlSeconds,
    });
  }
}

/**
 * Verifica firma, vencimiento, emisor y audiencia. Fijar `algorithms` evita aceptar tokens con otro algoritmo
 * (p. ej. `alg: none`).
 */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  constructor(private readonly secret: string) {}

  verify(token: string): AccessTokenClaims {
    let payload: JwtPayload | string;
    try {
      payload = jwt.verify(token, this.secret, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
    }
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
    }
    return { userId: payload.sub, email: payload.email };
  }
}
