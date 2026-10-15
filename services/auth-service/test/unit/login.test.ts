import { expect, it } from 'vitest';
import { alice, createTestContext, DUMMY_PASSWORD_HASH, NOW } from './fakes.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

it('[AUTH-02] login con credenciales válidas devuelve access y refresh token', async () => {
  const ctx = createTestContext();

  const tokens = await ctx.login.execute({ email: 'Alice@Demo.co', password: 'Demo1234!' });

  expect(tokens).toEqual({ accessToken: 'access-token-1', refreshToken: 'refresh-token-1', expiresIn: 900 });
  // Access token de 15 min cuyo sub es el id del usuario.
  expect(ctx.accessTokens.issued).toEqual([{ claims: { userId: alice.id, email: alice.email }, ttlSeconds: 900 }]);
  // El refresh token solo se persiste hasheado y vence en 7 días.
  expect(ctx.refreshTokens.all()).toEqual([
    {
      id: 'id-1',
      userId: alice.id,
      tokenHash: 'sha256:refresh-token-1',
      expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
      revokedAt: null,
      replacedBy: null,
      createdAt: NOW,
    },
  ]);
});

it('[AUTH-03] una contraseña errónea devuelve INVALID_CREDENTIALS y no emite tokens', async () => {
  const ctx = createTestContext();

  await expect(ctx.login.execute({ email: 'alice@demo.co', password: 'Incorrecta1' })).rejects.toMatchObject({
    code: 'INVALID_CREDENTIALS',
  });
  expect(ctx.accessTokens.issued).toHaveLength(0);
  expect(ctx.refreshTokens.all()).toHaveLength(0);
});

it('[AUTH-03] un email inexistente devuelve el mismo error y aun así compara contra un hash señuelo', async () => {
  const ctx = createTestContext();

  const wrongPassword = await ctx.login.execute({ email: 'alice@demo.co', password: 'Incorrecta1' }).catch((e: unknown) => e);
  const unknownEmail = await ctx.login.execute({ email: 'nadie@demo.co', password: 'Demo1234!' }).catch((e: unknown) => e);

  // Mismo código y mismo mensaje: la respuesta no revela cuál de los dos datos falló.
  expect(wrongPassword).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  expect(unknownEmail).toMatchObject({ code: 'INVALID_CREDENTIALS', message: (wrongPassword as Error).message });
  // También con el email inexistente se ejecutó una comparación de hash: no hay diferencia de tiempo que delate.
  expect(ctx.passwordHasher.verifiedAgainst).toEqual([alice.passwordHash, DUMMY_PASSWORD_HASH]);
});
