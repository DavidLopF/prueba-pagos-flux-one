import { DomainError } from '../errors.js';
import type { Money } from './Money.js';

export type PaymentLinkStatus = 'ACTIVE' | 'PAID';
/** EXPIRED no se guarda: se deriva de expiresAt (docs/spec.md §11). */
export type PaymentLinkVisibleStatus = PaymentLinkStatus | 'EXPIRED';

export const PAYMENT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface PaymentLinkProps {
  id: string;
  /** Cuenta que recibe el pago. */
  accountId: string;
  ownerId: string;
  amount: Money;
  description: string;
  status: PaymentLinkStatus;
  expiresAt: Date;
  paidTransferId: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** Cobro de monto fijo y un solo uso hacia una cuenta propia (PL-01..06). */
export class PaymentLink {
  private constructor(private props: PaymentLinkProps) {}

  static create(input: {
    id: string;
    accountId: string;
    ownerId: string;
    amount: Money;
    description: string;
    now: Date;
  }): PaymentLink {
    if (!input.amount.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'El monto debe ser mayor que cero');
    }
    return new PaymentLink({
      id: input.id,
      accountId: input.accountId,
      ownerId: input.ownerId,
      amount: input.amount,
      description: input.description,
      status: 'ACTIVE',
      expiresAt: new Date(input.now.getTime() + PAYMENT_LINK_TTL_MS),
      paidTransferId: null,
      paidAt: null,
      createdAt: input.now,
    });
  }

  static restore(props: PaymentLinkProps): PaymentLink {
    return new PaymentLink({ ...props });
  }

  get id(): string { return this.props.id; }
  get accountId(): string { return this.props.accountId; }
  get ownerId(): string { return this.props.ownerId; }
  get amount(): Money { return this.props.amount; }
  get description(): string { return this.props.description; }
  get expiresAt(): Date { return this.props.expiresAt; }
  get paidTransferId(): string | null { return this.props.paidTransferId; }
  get createdAt(): Date { return this.props.createdAt; }

  snapshot(): PaymentLinkProps {
    return { ...this.props };
  }

  statusAt(now: Date): PaymentLinkVisibleStatus {
    if (this.props.status === 'ACTIVE' && now.getTime() >= this.props.expiresAt.getTime()) return 'EXPIRED';
    return this.props.status;
  }

  /** Falla antes de mover dinero: ya pagado → INVALID_STATE (PL-04); vencido → PAYMENT_LINK_EXPIRED (PL-05). */
  assertPayable(now: Date): void {
    const status = this.statusAt(now);
    if (status === 'PAID') throw new DomainError('INVALID_STATE', 'El link ya fue pagado');
    if (status === 'EXPIRED') throw new DomainError('PAYMENT_LINK_EXPIRED', 'El link de pago venció');
  }

  markPaid(transferId: string, now: Date): void {
    this.assertPayable(now);
    this.props.status = 'PAID';
    this.props.paidTransferId = transferId;
    this.props.paidAt = now;
  }
}
