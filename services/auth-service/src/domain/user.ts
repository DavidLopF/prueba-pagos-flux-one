import { ValidationError } from './errors.js';

export interface User {
  readonly id: string;
  /** Siempre normalizado (ver normalizeEmail). */
  readonly email: string;
  /** Hash bcrypt; la contraseña en claro nunca se guarda (AUTH-01). */
  readonly passwordHash: string;
  readonly createdAt: Date;
}

/** Política de contraseñas (AUTH-01). La capa http reutiliza esta constante en su validación. */
export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `Alice@Demo.co ` y `alice@demo.co` son el mismo usuario: se compara y se guarda en minúsculas y sin espacios. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Reglas de registro (AUTH-01). Recibe el email ya normalizado. */
export function validateRegistration(email: string, password: string): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError('El email no tiene un formato válido');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}
