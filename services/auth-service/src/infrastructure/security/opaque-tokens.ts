import { createHash, randomBytes } from 'node:crypto';
import type { TokenGenerator, TokenHasher } from '../../domain/ports.js';

/** Refresh tokens opacos: 32 bytes aleatorios del CSPRNG (256 bits) codificados en base64url. */
export class CryptoTokenGenerator implements TokenGenerator {
  generate(): string {
    return randomBytes(32).toString('base64url');
  }
}

/**
 * SHA-256 y no bcrypt: el token ya tiene 256 bits de entropía (no se puede adivinar por fuerza bruta), y un hash
 * rápido y determinista permite buscarlo con el índice único de `token_hash`. Si se filtra la BD, los hashes no sirven
 * como tokens.
 */
export class Sha256TokenHasher implements TokenHasher {
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
