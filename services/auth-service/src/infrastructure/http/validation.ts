import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { MIN_PASSWORD_LENGTH } from '../../domain/user.js';

/** POST /auth/register: schema `Credentials` del contrato (email con formato válido, password de ≥ 8). */
export const registerBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

/**
 * POST /auth/login: solo se valida la forma. Un email mal escrito o una contraseña corta simplemente no coinciden
 * con ningún usuario → 401 INVALID_CREDENTIALS (AUTH-03), no 400.
 */
export const loginBodySchema = z.object({
  email: z.string(),
  password: z.string(),
});

/** POST /auth/refresh y POST /auth/logout. */
export const refreshTokenBodySchema = z.object({
  refreshToken: z.string(),
});

/** Valida el body con zod. Si no cumple lanza ValidationError → 400 VALIDATION_ERROR (CLAUDE.md §7). */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Petición inválida (${details})`);
  }
  return result.data;
}
