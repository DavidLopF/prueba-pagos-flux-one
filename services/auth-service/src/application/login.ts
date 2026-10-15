import { InvalidCredentialsError } from '../domain/errors.js';
import type { Clock, PasswordHasher, RefreshTokenRepository, UserRepository } from '../domain/ports.js';
import { normalizeEmail } from '../domain/user.js';
import type { SessionFactory, TokenPair } from './session-factory.js';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginDeps {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  passwordHasher: PasswordHasher;
  sessions: SessionFactory;
  clock: Clock;
  /** Hash (mismo algoritmo y coste que los reales) contra el que se compara cuando el email no existe. */
  dummyPasswordHash: string;
}

/** AUTH-02 / AUTH-03: valida credenciales y emite access token + refresh token. */
export class Login {
  constructor(private readonly deps: LoginDeps) {}

  async execute(input: LoginInput): Promise<TokenPair> {
    const user = await this.deps.users.findByEmail(normalizeEmail(input.email));

    // Si el email no existe igual se ejecuta una comparación bcrypt contra un hash señuelo: la respuesta tarda
    // lo mismo que con una contraseña errónea y no se puede averiguar qué emails existen midiendo tiempos.
    const passwordMatches = await this.deps.passwordHasher.verify(
      input.password,
      user?.passwordHash ?? this.deps.dummyPasswordHash,
    );
    if (!user || !passwordMatches) {
      throw new InvalidCredentialsError();
    }

    const session = this.deps.sessions.create(user, this.deps.clock.now());
    await this.deps.refreshTokens.insert(session.refreshTokenRecord);
    return session.tokens;
  }
}
