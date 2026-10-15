import { DomainError } from '../errors.js';

// NUMERIC(18,2) => hasta 16 dígitos enteros y 2 decimales.
const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

/**
 * Monto en COP representado en centavos con bigint (CLAUDE.md §2).
 * Nunca se usa `number` para dinero: no hay errores de punto flotante.
 */
export class Money {
  private constructor(readonly cents: bigint) {}

  static readonly ZERO = new Money(0n);

  /** Parsea el string decimal de la API/BD ("150000.50"). Lanza INVALID_AMOUNT si no es válido. */
  static fromString(value: unknown): Money {
    if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
      throw new DomainError('INVALID_AMOUNT', 'El monto debe ser un decimal positivo con máximo 2 decimales');
    }
    const [integerPart = '0', decimalPart = ''] = value.split('.');
    return new Money(BigInt(integerPart) * 100n + BigInt(decimalPart.padEnd(2, '0')));
  }

  static fromCents(cents: bigint): Money {
    if (cents < 0n) throw new DomainError('INVALID_AMOUNT', 'Un monto no puede ser negativo');
    return new Money(cents);
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  /** Resta sin permitir resultados negativos: el saldo negativo es imposible por construcción. */
  subtract(other: Money): Money {
    if (other.cents > this.cents) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Saldo insuficiente');
    }
    return new Money(this.cents - other.cents);
  }

  isLessThan(other: Money): boolean {
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  /** Formato canónico con 2 decimales, usado en la API, la BD y el hash de idempotencia. */
  toString(): string {
    const integerPart = this.cents / 100n;
    const decimalPart = (this.cents % 100n).toString().padStart(2, '0');
    return `${integerPart}.${decimalPart}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
