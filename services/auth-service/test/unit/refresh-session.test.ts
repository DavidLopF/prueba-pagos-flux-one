import { expect, it } from 'vitest';
import { createTestContext } from './fakes.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const aliceCredentials = { email: 'alice@demo.co', password: 'Demo1234!' };

it('[AUTH-05] refresh devuelve un par nuevo y revoca el refresh token anterior apuntando a su reemplazo', async () => {
  const ctx = createTestContext();
  const first = await ctx.login.execute(aliceCredentials);
  ctx.clock.advance(60_000);

  const second = await ctx.refreshSession.execute({ refreshToken: first.refreshToken });

  expect(second).toEqual({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2', expiresIn: 900 });
  const [previous, current] = ctx.refreshTokens.all();
  expect(current).toMatchObject({ tokenHash: 'sha256:refresh-token-2', revokedAt: null, replacedBy: null });
  expect(previous).toMatchObject({ tokenHash: 'sha256:refresh-token-1', revokedAt: ctx.clock.now(), replacedBy: current?.id });
});

it('[AUTH-05] reutilizar un refresh token ya rotado devuelve UNAUTHORIZED y revoca todas las sesiones del usuario', async () => {
  const ctx = createTestContext();
  const stolen = await ctx.login.execute(aliceCredentials);
  const otherDevice = await ctx.login.execute(aliceCredentials);
  const rotated = await ctx.refreshSession.execute({ refreshToken: stolen.refreshToken });

  await expect(ctx.refreshSession.execute({ refreshToken: stolen.refreshToken })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  // La revocación queda guardada aunque la respuesta sea 401 (no se deshace con la transacción).
  expect(ctx.refreshTokens.all().every((token) => token.revokedAt !== null)).toBe(true);
  await expect(ctx.refreshSession.execute({ refreshToken: rotated.refreshToken })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(ctx.refreshSession.execute({ refreshToken: otherDevice.refreshToken })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

it('[AUTH-05] un refresh token desconocido o vencido devuelve UNAUTHORIZED', async () => {
  const ctx = createTestContext();
  await expect(ctx.refreshSession.execute({ refreshToken: 'no-existe' })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  const { refreshToken } = await ctx.login.execute(aliceCredentials);
  ctx.clock.advance(SEVEN_DAYS_MS);

  await expect(ctx.refreshSession.execute({ refreshToken })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(ctx.refreshTokens.all()).toHaveLength(1);
});
