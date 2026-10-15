import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, type DomainErrorCode } from '../../domain/errors.js';

/**
 * Status HTTP por código de error (CLAUDE.md §7 y docs/openapi.yaml). Al ser un Record sobre DomainErrorCode,
 * añadir un código nuevo sin mapearlo aquí es un error de compilación.
 */
const HTTP_STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
};

/** Todas las respuestas de error tienen cuerpo `{ code, message }`. */
export function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof DomainError) {
    return reply.code(HTTP_STATUS_BY_CODE[error.code]).send({ code: error.code, message: error.message });
  }
  if (isFastifyClientError(error)) {
    return reply.code(error.statusCode).send({ code: 'VALIDATION_ERROR', message: error.message });
  }
  request.log.error({ err: error }, 'Error no controlado');
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor' });
}

/** Errores 4xx del propio Fastify: JSON mal formado, body demasiado grande, content-type no soportado… */
function isFastifyClientError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}
