import type { FastifyInstance } from 'fastify';
import type { GetCurrentUser } from '../../application/get-current-user.js';
import type { Login } from '../../application/login.js';
import type { Logout } from '../../application/logout.js';
import type { RefreshSession } from '../../application/refresh-session.js';
import type { RegisterUser } from '../../application/register-user.js';
import { UnauthorizedError } from '../../domain/errors.js';
import type { AccessTokenVerifier } from '../../domain/ports.js';
import { requireBearerToken } from './bearer-auth.js';
import { loginBodySchema, parseBody, refreshTokenBodySchema, registerBodySchema } from './validation.js';

export interface AuthRoutesDependencies {
  registerUser: RegisterUser;
  login: Login;
  refreshSession: RefreshSession;
  logout: Logout;
  getCurrentUser: GetCurrentUser;
  accessTokenVerifier: AccessTokenVerifier;
}

/** Rutas /auth/* (docs/openapi.yaml). Solo traducen HTTP ↔ casos de uso; las reglas viven en application/domain. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDependencies): void {
  app.post('/auth/register', async (request, reply) => {
    const body = parseBody(registerBodySchema, request.body);
    const user = await deps.registerUser.execute(body);
    return reply.code(201).send(user);
  });

  app.post('/auth/login', async (request) => {
    const body = parseBody(loginBodySchema, request.body);
    return deps.login.execute(body);
  });

  app.post('/auth/refresh', async (request) => {
    const body = parseBody(refreshTokenBodySchema, request.body);
    return deps.refreshSession.execute(body);
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = parseBody(refreshTokenBodySchema, request.body);
    await deps.logout.execute(body);
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireBearerToken(deps.accessTokenVerifier) }, async (request) => {
    if (!request.auth) {
      // El preHandler garantiza que existe; la comprobación además le dice a TypeScript que no es null.
      throw new UnauthorizedError('No autenticado');
    }
    return deps.getCurrentUser.execute({ userId: request.auth.userId });
  });
}
