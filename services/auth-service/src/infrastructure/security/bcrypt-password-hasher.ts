import bcrypt from 'bcryptjs';
import type { PasswordHasher } from '../../domain/ports.js';

/** Coste 10 ≈ 60 ms por hash/compare: caro para fuerza bruta, aceptable para un login. */
export const BCRYPT_COST = 10;

/**
 * bcrypt con bcryptjs (JS puro, sin binarios nativos). El salt va incluido en el hash resultante.
 * Limitación conocida de bcrypt: solo usa los primeros 72 bytes de la contraseña.
 */
export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly cost: number = BCRYPT_COST) {}

  hash(plainPassword: string): Promise<string> {
    return bcrypt.hash(plainPassword, this.cost);
  }

  verify(plainPassword: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, passwordHash);
  }
}
