import jwt from 'jsonwebtoken';
import { expect, it } from 'vitest';
import { UnauthorizedError } from '../../src/domain/errors.js';
import { JwtAccessTokenIssuer, JwtAccessTokenVerifier } from '../../src/infrastructure/security/jwt-access-tokens.js';

const SECRET = 'secreto-de-pruebas-unitarias-de-32-caracteres';
const claims = { userId: '11111111-1111-1111-1111-111111111111', email: 'alice@demo.co' };

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

it('[AUTH-02] el access token es un JWT HS256 de 15 min con sub = id de usuario, emitido por auth-service para payments-portal', () => {
  const token = new JwtAccessTokenIssuer(SECRET).issue(claims, 900);

  // Los mismos parámetros con los que verifican payments-service y audit-service.
  const decoded = jwt.verify(token, SECRET, {
    algorithms: ['HS256'],
    issuer: 'auth-service',
    audience: 'payments-portal',
    complete: true,
  });
  expect(decoded.header.alg).toBe('HS256');
  if (typeof decoded.payload === 'string') throw new Error('payload inesperado');
  expect(decoded.payload).toMatchObject({ sub: claims.userId, email: claims.email });
  expect(decoded.payload.exp).toBe((decoded.payload.iat ?? 0) + 900);

  expect(new JwtAccessTokenVerifier(SECRET).verify(token)).toEqual(claims);
});

it('[AUTH-02] el verificador rechaza tokens vencidos, firmados con otro secreto, de otra audiencia o con alg none', () => {
  const verifier = new JwtAccessTokenVerifier(SECRET);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expired = new JwtAccessTokenIssuer(SECRET).issue(claims, -10);
  const otherSecret = new JwtAccessTokenIssuer('otro-secreto-de-pruebas-de-32-caracteres').issue(claims, 900);
  const otherAudience = jwt.sign({ email: claims.email }, SECRET, {
    algorithm: 'HS256',
    subject: claims.userId,
    issuer: 'auth-service',
    audience: 'otra-aplicacion',
    expiresIn: 900,
  });
  const unsigned = [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({ sub: claims.userId, email: claims.email, iss: 'auth-service', aud: 'payments-portal', exp: nowSeconds + 900 }),
    '',
  ].join('.');

  for (const token of [expired, otherSecret, otherAudience, unsigned, 'no-es-un-jwt']) {
    expect(() => verifier.verify(token)).toThrow(UnauthorizedError);
  }
});
