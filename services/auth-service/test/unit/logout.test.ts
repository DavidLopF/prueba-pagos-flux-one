import { expect, it } from 'vitest';
import { createTestContext, NOW } from './fakes.js';

const aliceCredentials = { email: 'alice@demo.co', password: 'Demo1234!' };

it('[AUTH-05] logout revoca el refresh token actual sin cerrar las otras sesiones del usuario', async () => {
  const ctx = createTestContext();
  const loggedOut = await ctx.login.execute(aliceCredentials);
  const otherDevice = await ctx.login.execute(aliceCredentials);

  await ctx.logout.execute({ refreshToken: loggedOut.refreshToken });

  expect(ctx.refreshTokens.all()[0]).toMatchObject({ revokedAt: NOW, replacedBy: null });
  await expect(ctx.refreshSession.execute({ refreshToken: loggedOut.refreshToken })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  // Un token cerrado por logout no es una reutilización: la otra sesión sigue viva.
  await expect(ctx.refreshSession.execute({ refreshToken: otherDevice.refreshToken })).resolves.toMatchObject({
    expiresIn: 900,
  });
});

it('[AUTH-05] logout es idempotente: repetirlo o enviar un token desconocido no falla', async () => {
  const ctx = createTestContext();
  const { refreshToken } = await ctx.login.execute(aliceCredentials);
  await ctx.logout.execute({ refreshToken });
  ctx.clock.advance(1_000);

  await expect(ctx.logout.execute({ refreshToken })).resolves.toBeUndefined();
  await expect(ctx.logout.execute({ refreshToken: 'no-existe' })).resolves.toBeUndefined();
  // La fecha de revocación original no se reescribe.
  expect(ctx.refreshTokens.all()[0]?.revokedAt).toEqual(NOW);
});
