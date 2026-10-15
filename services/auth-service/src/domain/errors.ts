/**
 * Errores de negocio del servicio de autenticación.
 * Cada error lleva un `code` estable (el mismo que viaja en el cuerpo HTTP `{ code, message }`);
 * la traducción a status HTTP vive en la capa http (CLAUDE.md §7), no aquí.
 */
export type DomainErrorCode = 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'INVALID_CREDENTIALS' | 'EMAIL_TAKEN';

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Datos de entrada con forma o valor inválido (400). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

/** Falta el token, es inválido, expiró o fue revocado (401). */
export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED';
}

/** Email o contraseña incorrectos; el mensaje no dice cuál de los dos falló (AUTH-03, 401). */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Email o contraseña incorrectos');
  }
}

/** Ya existe un usuario con ese email (AUTH-01, 409). */
export class EmailTakenError extends DomainError {
  readonly code = 'EMAIL_TAKEN';

  constructor() {
    super('El email ya está registrado');
  }
}
