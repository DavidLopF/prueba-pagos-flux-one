import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { GetTransferAuditHistory } from '../../application/get-transfer-audit-history.js';
import type { AuditEvent } from '../../domain/audit-event.js';
import type { AccessTokenVerifier, AuthenticatedUser } from './jwt-access-token-verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on every non-public route. */
    user: AuthenticatedUser | null;
  }
}

export interface AppDependencies {
  getTransferAuditHistory: GetTransferAuditHistory;
  tokenVerifier: AccessTokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

/** Error carrying the HTTP status and the contract's `{ code, message }` body. */
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PUBLIC_ROUTES = new Set(['/health']);
const transferParamsSchema = z.object({ id: z.string().uuid() });

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorateRequest('user', null);

  // AUTH-04: everything except /health needs a valid bearer token (unknown routes included).
  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;
    request.user = authenticate(request.headers.authorization, deps.tokenVerifier);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // AUD-05
  app.get('/audit/transfers/:id/events', async (request) => {
    const params = transferParamsSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'VALIDATION_ERROR', 'id must be a UUID');
    const events = await deps.getTransferAuditHistory.execute({
      transferId: params.data.id,
      viewerId: currentUser(request).id,
    });
    return events.map(toResponse);
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found' }));

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (isClientError(error)) {
      // Raised by Fastify itself for malformed requests.
      return reply.code(error.statusCode).send({ code: 'VALIDATION_ERROR', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  return app;
}

function authenticate(header: string | undefined, verifier: AccessTokenVerifier): AuthenticatedUser {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Missing bearer token');
  try {
    return verifier.verify(token);
  } catch {
    // The reason (expired, bad signature…) and the token itself are deliberately not exposed or logged.
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}

function currentUser(request: FastifyRequest): AuthenticatedUser {
  // Unreachable on protected routes (the hook already rejected the request), kept so types stay honest.
  if (!request.user) throw new HttpError(401, 'UNAUTHORIZED', 'Missing bearer token');
  return request.user;
}

/** Contract `AuditEvent`. participantIds stay internal: they are other users' ids. */
function toResponse(event: AuditEvent) {
  return {
    eventId: event.eventId,
    transferId: event.transferId,
    eventType: event.eventType,
    status: event.status,
    actorId: event.actorId,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  };
}

function isClientError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}
