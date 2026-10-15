import { DomainError } from '../errors.js';
import { Money } from './Money.js';

export class Account {
  constructor(
    readonly id: string,
    readonly ownerId: string,
    private currentBalance: Money,
  ) {}

  get balance(): Money {
    return this.currentBalance;
  }

  isOwnedBy(userId: string): boolean {
    return this.ownerId === userId;
  }

  assertOwnedBy(userId: string): void {
    if (!this.isOwnedBy(userId)) {
      throw new DomainError('FORBIDDEN_ACCOUNT', `La cuenta ${this.id} no pertenece al usuario`);
    }
  }

  /** Lanza INSUFFICIENT_FUNDS antes de mutar: nunca queda saldo negativo. */
  debit(amount: Money): void {
    this.currentBalance = this.currentBalance.subtract(amount);
  }

  credit(amount: Money): void {
    this.currentBalance = this.currentBalance.add(amount);
  }
}
