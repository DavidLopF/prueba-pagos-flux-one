/**
 * Errores de negocio. El adaptador HTTP traduce `code` a un status (CLAUDE.md §7);
 * el dominio no conoce HTTP.
 */
export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'SAME_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'FORBIDDEN_ACCOUNT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_KEY_REUSED';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
