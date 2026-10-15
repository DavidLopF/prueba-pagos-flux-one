import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../domain/errors.js';
import type { AccessTokenClaims, AccessTokenVerifier } from '../../domain/ports.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Claims del access token verificado. Solo lo rellena el hook requireBearerToken (rutas protegidas). */
    auth: AccessTokenClaims | null;
  }
}

/** `Authorization: Bearer <token>`; el esquema "Bearer" no distingue mayúsculas (RFC 7235). */
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;

/** preHandler de rutas protegidas: sin token, o con uno inválido/vencido, responde 401 UNAUTHORIZED. */
export function requireBearerToken(verifier: AccessTokenVerifier) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = BEARER_PATTERN.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw new UnauthorizedError('Falta el header Authorization: Bearer <token>');
    }
    request.auth = verifier.verify(token);
  };
}
