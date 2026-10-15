import { UnauthorizedError } from '../domain/errors.js';
import type { UserRepository } from '../domain/ports.js';
import { toUserView, type UserView } from './user-view.js';

export interface GetCurrentUserInput {
  /** `sub` del access token ya verificado. */
  userId: string;
}

export interface GetCurrentUserDeps {
  users: UserRepository;
}

/** GET /auth/me: datos del usuario dueño del access token. */
export class GetCurrentUser {
  constructor(private readonly deps: GetCurrentUserDeps) {}

  async execute(input: GetCurrentUserInput): Promise<UserView> {
    const user = await this.deps.users.findById(input.userId);
    if (!user) {
      // Token bien firmado pero de un usuario que ya no existe: se trata como no autenticado.
      throw new UnauthorizedError('El usuario del token no existe');
    }
    return toUserView(user);
  }
}
