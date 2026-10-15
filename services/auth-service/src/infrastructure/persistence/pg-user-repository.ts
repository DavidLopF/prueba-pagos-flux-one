import type { UserRepository } from '../../domain/ports.js';
import type { User } from '../../domain/user.js';
import type { Queryable } from './database.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

const SELECT_USER = 'SELECT id, email, password_hash, created_at FROM auth_schema.users';

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>(`${SELECT_USER} WHERE id = $1`, [id]);
    const [row] = rows;
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>(`${SELECT_USER} WHERE email = $1`, [email]);
    const [row] = rows;
    return row ? toUser(row) : null;
  }

  async insertIfEmailAvailable(user: User): Promise<boolean> {
    // ON CONFLICT DO NOTHING: con un email repetido no se lanza error, simplemente no se inserta ninguna fila.
    const result = await this.db.query(
      `INSERT INTO auth_schema.users (id, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [user.id, user.email, user.passwordHash, user.createdAt],
    );
    return result.rowCount === 1;
  }
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at };
}
