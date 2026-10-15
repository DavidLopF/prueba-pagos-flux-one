import type { RefreshTokenRepository } from '../../domain/ports.js';
import type { RefreshToken } from '../../domain/refresh-token.js';
import type { Queryable } from './database.js';

interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
}

const SELECT_BY_HASH = `SELECT id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at
  FROM auth_schema.refresh_tokens
  WHERE token_hash = $1`;

export class PgRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: Queryable) {}

  findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.selectOne(SELECT_BY_HASH, tokenHash);
  }

  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    // Solo tiene efecto dentro de una transacción (PgUnitOfWork): la fila queda bloqueada hasta el COMMIT/ROLLBACK.
    return this.selectOne(`${SELECT_BY_HASH} FOR UPDATE`, tokenHash);
  }

  async insert(token: RefreshToken): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_schema.refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token.id, token.userId, token.tokenHash, token.expiresAt, token.revokedAt, token.replacedBy, token.createdAt],
    );
  }

  async revoke(id: string, revokedAt: Date, replacedBy: string | null): Promise<boolean> {
    // UPDATE condicional: si otro proceso ya lo revocó, afecta 0 filas y devolvemos false.
    const result = await this.db.query(
      `UPDATE auth_schema.refresh_tokens
       SET revoked_at = $2, replaced_by = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, revokedAt, replacedBy],
    );
    return result.rowCount === 1;
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE auth_schema.refresh_tokens
       SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, revokedAt],
    );
  }

  private async selectOne(sql: string, tokenHash: string): Promise<RefreshToken | null> {
    const { rows } = await this.db.query<RefreshTokenRow>(sql, [tokenHash]);
    const [row] = rows;
    return row ? toRefreshToken(row) : null;
  }
}

function toRefreshToken(row: RefreshTokenRow): RefreshToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    replacedBy: row.replaced_by,
    createdAt: row.created_at,
  };
}
