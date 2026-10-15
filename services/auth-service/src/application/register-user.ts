import { EmailTakenError } from '../domain/errors.js';
import type { Clock, IdGenerator, PasswordHasher, UserRepository } from '../domain/ports.js';
import { normalizeEmail, validateRegistration, type User } from '../domain/user.js';
import { toUserView, type UserView } from './user-view.js';

export interface RegisterUserInput {
  email: string;
  password: string;
}

export interface RegisterUserDeps {
  users: UserRepository;
  passwordHasher: PasswordHasher;
  ids: IdGenerator;
  clock: Clock;
}

/** AUTH-01: crea un usuario guardando solo el hash bcrypt de su contraseña. */
export class RegisterUser {
  constructor(private readonly deps: RegisterUserDeps) {}

  async execute(input: RegisterUserInput): Promise<UserView> {
    const email = normalizeEmail(input.email);
    validateRegistration(email, input.password);

    const user: User = {
      id: this.deps.ids.next(),
      email,
      passwordHash: await this.deps.passwordHasher.hash(input.password),
      createdAt: this.deps.clock.now(),
    };
    // La unicidad la decide la BD (índice único): dos registros simultáneos del mismo email no pueden pasar ambos.
    const inserted = await this.deps.users.insertIfEmailAvailable(user);
    if (!inserted) {
      throw new EmailTakenError();
    }
    return toUserView(user);
  }
}
