import type { User } from '../domain/user.js';

/** Lo que se expone de un usuario hacia fuera (schema `User` del contrato): nunca el hash. */
export interface UserView {
  id: string;
  email: string;
}

export function toUserView(user: User): UserView {
  return { id: user.id, email: user.email };
}
