import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import type { CreateTransfer } from '../../application/CreateTransfer.js';
import type { PaymentLinks } from '../../application/paymentLinks.js';
import type { TransferQueries } from '../../application/queries.js';
import type { ReverseTransfer } from '../../application/ReverseTransfer.js';
import type { TransferView } from '../../application/views.js';
import { DomainError, type DomainErrorCode } from '../../domain/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
  interface FastifyContextConfig {
    /** Ruta accesible sin JWT. */
    public?: boolean;
  }
}

export interface AppDependencies {
  createTransfer: CreateTransfer;
  reverseTransfer: ReverseTransfer;
  queries: TransferQueries;
  paymentLinks: PaymentLinks;
  jwtSecret: string;
  /** Avisa al worker del riel que hay trabajo nuevo (opcional). */
  onRailWorkQueued?: () => void;
  logger?: boolean;
}

/** CLAUDE.md §7 */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  INVALID_AMOUNT: 422,
  SAME_ACCOUNT: 422,
  ACCOUNT_NOT_FOUND: 422,
  INSUFFICIENT_FUNDS: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  FORBIDDEN_ACCOUNT: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  PAYMENT_LINK_EXPIRED: 422,
};

const createTransferBody = z.object({
  type: z.enum(['INTERNAL', 'EXTERNAL']),
  fromAccount: z.string().trim().min(1).max(64),
  toAccount: z.string().trim().min(1).max(64),
  // El formato del monto lo valida el dominio (Money) para responder 422 INVALID_AMOUNT.
  amount: z.string().max(32),
});
const transferIdParams = z.object({ id: z.string().uuid() });
const accountParams = z.object({ accountId: z.string().min(1).max(64) });
const listQuery = z.object({ account: z.string().min(1).max(64) });
const idempotencyKeyHeader = z.string().trim().min(1).max(255);
const createPaymentLinkBody = z.object({
  accountId: z.string().trim().min(1).max(64),
  amount: z.string().max(32),
  description: z.string().trim().min(1).max(140),
});
const payPaymentLinkBody = z.object({ fromAccount: z.string().trim().min(1).max(64) });

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  // Acepta cuerpos JSON vacíos (p. ej. POST /reversal sin body pero con content-type).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(new DomainValidationError('JSON inválido'), undefined);
    }
  });

  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.public) return;
    const userId = verifyBearer(request, deps.jwtSecret);
    if (!userId) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Token ausente, inválido o vencido' });
    }
    request.userId = userId;
  });

  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  app.post('/transfers', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = createTransferBody.parse(request.body);
    const { result, replayed } = await deps.createTransfer.execute({ userId: request.userId, idempotencyKey, ...body });
    if (result.type === 'EXTERNAL') deps.onRailWorkQueued?.();
    return sendTransfer(reply, result, replayed, result.status === 'PENDING' ? 202 : 201);
  });

  app.get('/transfers', async (request) => {
    const { account } = listQuery.parse(request.query);
    return deps.queries.listAccountTransfers(request.userId, account);
  });

  app.get('/transfers/:id', async (request) => {
    const { id } = transferIdParams.parse(request.params);
    return deps.queries.getTransfer(request.userId, id);
  });

  app.post('/transfers/:id/reversal', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const { id } = transferIdParams.parse(request.params);
    const { result, replayed } = await deps.reverseTransfer.execute({
      userId: request.userId,
      idempotencyKey,
      transferId: id,
    });
    if (result.status === 'REVERSAL_PENDING') deps.onRailWorkQueued?.();
    return sendTransfer(reply, result, replayed, result.status === 'REVERSAL_PENDING' ? 202 : 200);
  });

  app.get('/accounts', async (request) => deps.queries.listMyAccounts(request.userId));

  app.get('/accounts/:accountId/balance', async (request) => {
    const { accountId } = accountParams.parse(request.params);
    return deps.queries.getBalance(request.userId, accountId);
  });

  app.post('/payment-links', async (request, reply) => {
    const body = createPaymentLinkBody.parse(request.body);
    const link = await deps.paymentLinks.create({ userId: request.userId, ...body });
    return reply.code(201).send(link);
  });

  app.get('/payment-links', async (request) => {
    const { account } = listQuery.parse(request.query);
    return deps.paymentLinks.listByAccount(request.userId, account);
  });

  app.get('/payment-links/:id/public', { config: { public: true } }, async (request) => {
    const { id } = transferIdParams.parse(request.params);
    return deps.paymentLinks.getPublic(id);
  });

  app.post('/payment-links/:id/pay', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const { id } = transferIdParams.parse(request.params);
    const { fromAccount } = payPaymentLinkBody.parse(request.body);
    const { result, replayed } = await deps.paymentLinks.pay({
      userId: request.userId,
      idempotencyKey,
      linkId: id,
      fromAccount,
    });
    return sendTransfer(reply, result, replayed, 201);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(STATUS_BY_CODE[error.code]).send({ code: error.code, message: error.message });
    }
    if (error instanceof IdempotencyKeyRequiredError) {
      return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: error.message });
    }
    if (error instanceof ZodError || error instanceof DomainValidationError) {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Error interno' });
  });

  return app;
}

class IdempotencyKeyRequiredError extends Error {}
class DomainValidationError extends Error {}

function requireIdempotencyKey(request: FastifyRequest): string {
  const parsed = idempotencyKeyHeader.safeParse(request.headers['idempotency-key']);
  if (!parsed.success) {
    throw new IdempotencyKeyRequiredError('El header Idempotency-Key es obligatorio');
  }
  return parsed.data;
}

function sendTransfer(reply: FastifyReply, view: TransferView, replayed: boolean, status: number) {
  if (replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.code(status).send(view);
}

/** Devuelve el `sub` del JWT emitido por auth-service, o null si no es válido (AUTH-04). */
function verifyBearer(request: FastifyRequest, secret: string): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const claims = jwt.verify(header.slice('Bearer '.length), secret, {
      algorithms: ['HS256'],
      issuer: 'auth-service',
      audience: 'payments-portal',
    });
    return typeof claims === 'object' && typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}
