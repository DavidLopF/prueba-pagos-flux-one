import jwt from 'jsonwebtoken';
import { z } from 'zod';

export interface AuthenticatedUser {
  id: string;
}

/** Throws when the token is invalid, expired or not meant for this system. */
export interface AccessTokenVerifier {
  verify(token: string): AuthenticatedUser;
}

// `sub` is matched against participant_ids (uuid[]), so anything else is rejected up front.
const claimsSchema = z.object({ sub: z.string().uuid() });

/** Validates access tokens issued by auth-service (HS256 with the shared secret). */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  constructor(private readonly secret: string) {}

  verify(token: string): AuthenticatedUser {
    const payload = jwt.verify(token, this.secret, {
      algorithms: ['HS256'], // pinned: never accept "none" or an algorithm chosen by the token
      issuer: 'auth-service',
      audience: 'payments-portal',
    });
    const claims = claimsSchema.parse(payload);
    return { id: claims.sub };
  }
}
