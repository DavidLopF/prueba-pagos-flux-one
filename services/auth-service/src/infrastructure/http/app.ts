import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuthRoutes, type AuthRoutesDependencies } from './auth-routes.js';
import { handleError } from './error-handler.js';

export type AppDependencies = AuthRoutesDependencies;

export interface BuildAppOptions {
  /** false en tests; main.ts pasa la configuración de pino. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Construye la app Fastify sin escuchar en ningún puerto: main.ts la arranca con listen() y los tests de
 * aceptación la ejercitan con app.inject().
 */
export function buildApp(deps: AppDependencies, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.decorateRequest('auth', null);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ code: 'NOT_FOUND', message: `Ruta no encontrada: ${request.method} ${request.url}` }),
  );

  app.get('/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app, deps);

  return app;
}
