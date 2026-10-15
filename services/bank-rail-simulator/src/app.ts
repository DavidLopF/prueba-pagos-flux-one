import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { MODES, Rail, isValidAmount, type RailOptions, type RailReply } from './rail.js';

/** Mayor que el timeout del cliente (10 s): cuando el banco por fin responde, el cliente ya se rindió. */
export const DEFAULT_TIMEOUT_DELAY_MS = 15_000;

export interface AppOptions extends RailOptions {
  /** Cuánto tarda en responder una operación en timeout. */
  timeoutDelayMs?: number;
  logger?: boolean;
}

const text = z.string().min(1);
const amount = z.string().refine(isValidAmount);
const TransferBody = z.object({ reference: text, from: text, to: text, amount });
const ReversalBody = z.object({ reference: text, originalReference: text, amount });
const ModeBody = z.object({ mode: z.enum(MODES) });
const BAD_REQUEST = { error: 'BAD_REQUEST' };

/** Rutas HTTP del riel. La lógica vive en `Rail`; aquí solo se valida el body, se loguea y se responde. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const rail = new Rail(options);
  const timeoutDelayMs = options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS;
  // Se escribe una línea de log por operación (en `send`), así que se apaga el log automático por request.
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Lo que Fastify rechaza antes de llegar a la ruta (JSON mal formado, content-type no soportado…)
  // responde con el mismo contrato que un body inválido.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.code(400).send(BAD_REQUEST);
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });

  /** Envía lo que decidió el riel; si es un timeout, primero espera. Loguea la decisión, nunca el body. */
  async function send(reply: FastifyReply, operation: string, reference: string, result: RailReply) {
    reply.log.info({ reference, outcome: result.outcome, statusCode: result.statusCode }, operation);
    if (result.delayed) await sleep(timeoutDelayMs);
    return reply.code(result.statusCode).send(result.body);
  }

  /** 400 sin tocar el riel. Se loguean solo los nombres de los campos inválidos. */
  function badRequest(reply: FastifyReply, error: z.ZodError) {
    reply.log.info({ fields: error.issues.map((issue) => issue.path.join('.')) }, 'bad request');
    return reply.code(400).send(BAD_REQUEST);
  }

  app.post('/rail/transfers', async (request, reply) => {
    const body = TransferBody.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    return send(reply, 'transfer', body.data.reference, rail.submitTransfer(body.data));
  });

  app.post('/rail/reversals', async (request, reply) => {
    const body = ReversalBody.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    return send(reply, 'reversal', body.data.reference, rail.submitReversal(body.data));
  });

  app.get<{ Params: { reference: string } }>('/rail/transfers/:reference', async (request, reply) => {
    const { reference } = request.params;
    return send(reply, 'lookup', reference, rail.lookup(reference));
  });

  app.get('/rail/admin/mode', async () => ({ mode: rail.mode }));

  app.put('/rail/admin/mode', async (request, reply) => {
    const body = ModeBody.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    rail.mode = body.data.mode;
    request.log.info({ mode: rail.mode }, 'admin mode');
    return { mode: rail.mode };
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
