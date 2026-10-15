/**
 * Refresh token opaco. Solo se persiste su hash SHA-256 (`tokenHash`), nunca el valor que recibe el cliente.
 * Cada uso lo rota: se revoca (`revokedAt`) y apunta al token que lo reemplazó (`replacedBy`).
 */
export interface RefreshToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  /** Id del token emitido al rotar este; null si nunca se rotó (activo o revocado por logout). */
  readonly replacedBy: string | null;
  readonly createdAt: Date;
}

export function isRevoked(token: RefreshToken): boolean {
  return token.revokedAt !== null;
}

export function isExpired(token: RefreshToken, now: Date): boolean {
  return token.expiresAt.getTime() <= now.getTime();
}

/** Un token ya rotado que vuelve a presentarse es señal de robo (detección de reutilización, AUTH-05). */
export function wasRotated(token: RefreshToken): boolean {
  return token.replacedBy !== null;
}
