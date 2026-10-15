import { expect, it } from 'vitest';
import { createTestContext } from './fakes.js';

it('[AUTH-01] registra un usuario nuevo con el email normalizado y guarda solo el hash de la contraseña', async () => {
  const ctx = createTestContext();

  const user = await ctx.registerUser.execute({ email: '  Nuevo@Demo.CO ', password: 'Secreta123' });

  expect(user).toEqual({ id: 'id-1', email: 'nuevo@demo.co' });
  const stored = await ctx.users.findById('id-1');
  expect(stored?.passwordHash).toBe('hashed:Secreta123');
});

it('[AUTH-01] un email ya registrado (aunque cambien las mayúsculas) devuelve EMAIL_TAKEN', async () => {
  const ctx = createTestContext();

  await expect(ctx.registerUser.execute({ email: 'ALICE@demo.co', password: 'OtraClave123' })).rejects.toMatchObject({
    code: 'EMAIL_TAKEN',
  });
  expect(ctx.users.all()).toHaveLength(1);
});

it('[AUTH-01] una contraseña de menos de 8 caracteres o un email mal formado devuelven VALIDATION_ERROR', async () => {
  const ctx = createTestContext([]);

  await expect(ctx.registerUser.execute({ email: 'nuevo@demo.co', password: '1234567' })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  await expect(ctx.registerUser.execute({ email: 'no-es-un-email', password: 'Secreta123' })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  expect(ctx.users.all()).toHaveLength(0);
});
