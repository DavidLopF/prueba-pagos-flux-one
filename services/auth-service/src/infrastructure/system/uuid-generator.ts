import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../domain/ports.js';

/** UUID v4 aleatorio (columnas `uuid` de la BD). */
export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
