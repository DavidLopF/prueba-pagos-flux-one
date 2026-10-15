// Tipos del contrato HTTP (docs/openapi.yaml). Los montos son SIEMPRE string decimal ("150000.50").

export type Money = string;

export type TransferType = 'INTERNAL' | 'EXTERNAL';

export type TransferStatus =
  | 'PENDING'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'FAILED'
  | 'REVERSAL_PENDING'
  | 'REVERSED';

export interface Transfer {
  id: string;
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: Money;
  currency: 'COP';
  status: TransferStatus;
  attempts: number;
  requiresManualReview: boolean;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransferRequest {
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: Money;
}

export interface Balance {
  accountId: string;
  balance: Money;
  currency: 'COP';
}

export type AuditEventType =
  | 'TRANSFER_CREATED'
  | 'TRANSFER_COMPLETED'
  | 'TRANSFER_FAILED'
  | 'TRANSFER_UNKNOWN'
  | 'TRANSFER_REVERSAL_REQUESTED'
  | 'TRANSFER_REVERSED'
  | 'TRANSFER_REVERSAL_REJECTED';

export interface AuditEvent {
  eventId: string;
  transferId: string;
  eventType: AuditEventType;
  status: TransferStatus;
  actorId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

// Payment links (PL): cobro de monto fijo hacia una cuenta propia; de un solo uso, vence a las 24 h.
export type PaymentLinkStatus = 'ACTIVE' | 'PAID' | 'EXPIRED';

/** Lo que cualquiera (sin sesión) puede ver de un link: GET /payment-links/{id}/public. */
export interface PublicPaymentLink {
  id: string;
  accountId: string;
  amount: Money;
  currency: 'COP';
  description: string;
  status: PaymentLinkStatus;
  expiresAt: string;
}

/** Vista del dueño del link (incluye la transferencia con la que se pagó). */
export interface PaymentLink extends PublicPaymentLink {
  paidTransferId: string | null;
  createdAt: string;
}

export interface CreatePaymentLinkRequest {
  accountId: string;
  amount: Money;
  description: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface User {
  id: string;
  email: string;
}

/** Cuerpo de error común a todos los servicios: { code, message }. */
export interface ErrorBody {
  code: string;
  message: string;
}

// Estados estables (FE-02): el detalle deja de hacer polling al llegar a uno de ellos.
// COMPLETED solo vuelve a cambiar si el usuario pide un reverso.
const STABLE_STATUSES: ReadonlySet<TransferStatus> = new Set(['COMPLETED', 'FAILED', 'REVERSED']);

export function isStable(status: TransferStatus): boolean {
  return STABLE_STATUSES.has(status);
}
