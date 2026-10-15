/** Vida del access token: 15 minutos (AUTH-02, CLAUDE.md §6). Se devuelve al cliente como `expiresIn`. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Vida del refresh token: 7 días. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
