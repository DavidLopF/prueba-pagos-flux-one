import { DomainError } from '../errors.js';
import { Money } from './Money.js';

export type TransferType = 'INTERNAL' | 'EXTERNAL';

export type TransferStatus =
  | 'PENDING'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'FAILED'
  | 'REVERSAL_PENDING'
  | 'REVERSED';

export type TransferEventType =
  | 'TRANSFER_CREATED'
  | 'TRANSFER_COMPLETED'
  | 'TRANSFER_FAILED'
  | 'TRANSFER_UNKNOWN'
  | 'TRANSFER_REVERSAL_REQUESTED'
  | 'TRANSFER_REVERSED'
  | 'TRANSFER_REVERSAL_REJECTED';

/** Máquina de estados (CLAUDE.md §4, docs/spec.md §1). Cualquier otra transición es INVALID_STATE. */
const ALLOWED_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  PENDING: ['COMPLETED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REVERSAL_PENDING'],
  REVERSAL_PENDING: ['REVERSED', 'COMPLETED'],
  FAILED: [],
  REVERSED: [],
};

/** Estados con trabajo pendiente en el riel bancario (los procesa el worker). */
export const RAIL_PENDING_STATUSES: readonly TransferStatus[] = ['PENDING', 'UNKNOWN', 'REVERSAL_PENDING'];

/** Evento de dominio; el outbox le asigna el eventId al persistirlo. */
export interface TransferEvent {
  eventType: TransferEventType;
  transferId: string;
  occurredAt: Date;
  actorId: string | null;
  participantIds: string[];
  payload: {
    transferId: string;
    type: TransferType;
    fromAccount: string;
    toAccount: string;
    amount: string;
    status: TransferStatus;
    previousStatus: TransferStatus | null;
    reason?: string;
  };
}

export interface TransferProps {
  id: string;
  type: TransferType;
  fromAccount: string;
  toAccount: string;
  amount: Money;
  status: TransferStatus;
  /** Dueño de la cuenta origen: único que puede reversar. */
  ownerId: string;
  /** Dueño de la cuenta destino (solo INTERNAL). También puede consultar la transferencia. */
  counterpartyOwnerId: string | null;
  /** Intentos de procesamiento en el riel; lo incrementa el claim del worker antes de llamar al riel. */
  attempts: number;
  nextAttemptAt: Date | null;
  requiresManualReview: boolean;
  /** Reference del reverso enviado al riel (solo EXTERNAL en REVERSAL_PENDING/REVERSED). */
  reversalId: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Quién y cuándo provoca un cambio. actorId = null cuando es el sistema (worker). */
export interface ChangeContext {
  now: Date;
  actorId: string | null;
}

export class Transfer {
  private pendingEvents: TransferEvent[] = [];

  private constructor(private props: TransferProps) {}

  /** Toda transferencia nace PENDING. Las internas se completan en la misma transacción. */
  static create(input: {
    id: string;
    type: TransferType;
    fromAccount: string;
    toAccount: string;
    amount: Money;
    ownerId: string;
    counterpartyOwnerId: string | null;
    now: Date;
  }): Transfer {
    if (!input.amount.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'El monto debe ser mayor que cero');
    }
    if (input.fromAccount === input.toAccount) {
      throw new DomainError('SAME_ACCOUNT', 'La cuenta origen y la destino deben ser distintas');
    }
    const transfer = new Transfer({
      ...input,
      status: 'PENDING',
      attempts: 0,
      // Las externas quedan listas para que el worker las envíe al riel de inmediato.
      nextAttemptAt: input.type === 'EXTERNAL' ? input.now : null,
      requiresManualReview: false,
      reversalId: null,
      failureReason: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    transfer.record('TRANSFER_CREATED', null, { now: input.now, actorId: input.ownerId });
    return transfer;
  }

  /** Reconstruye desde persistencia, sin emitir eventos. */
  static restore(props: TransferProps): Transfer {
    return new Transfer({ ...props });
  }

  get id(): string { return this.props.id; }
  get type(): TransferType { return this.props.type; }
  get fromAccount(): string { return this.props.fromAccount; }
  get toAccount(): string { return this.props.toAccount; }
  get amount(): Money { return this.props.amount; }
  get status(): TransferStatus { return this.props.status; }
  get ownerId(): string { return this.props.ownerId; }
  get counterpartyOwnerId(): string | null { return this.props.counterpartyOwnerId; }
  get attempts(): number { return this.props.attempts; }
  get nextAttemptAt(): Date | null { return this.props.nextAttemptAt; }
  get requiresManualReview(): boolean { return this.props.requiresManualReview; }
  get reversalId(): string | null { return this.props.reversalId; }
  get failureReason(): string | null { return this.props.failureReason; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  snapshot(): TransferProps {
    return { ...this.props };
  }

  isVisibleTo(userId: string): boolean {
    return this.props.ownerId === userId || this.props.counterpartyOwnerId === userId;
  }

  /**
   * attempts ya incluye el intento en curso (el claim lo incrementa antes de llamar al riel).
   * Si es > 1, un intento anterior pudo llegar al banco: hay que consultar antes de reenviar (EXT-07).
   */
  mayHaveReachedRail(): boolean {
    return this.props.attempts > 1;
  }

  markCompleted(ctx: ChangeContext): void {
    this.transitionTo('COMPLETED', 'TRANSFER_COMPLETED', ctx);
  }

  /** El reembolso al origen lo hace el caso de uso en la misma transacción. */
  markFailed(reason: string, ctx: ChangeContext): void {
    this.props.failureReason = reason;
    this.transitionTo('FAILED', 'TRANSFER_FAILED', ctx, reason);
  }

  /** Timeout del riel: nunca se convierte en FAILED (EXT-05). */
  markUnknown(ctx: ChangeContext): void {
    this.transitionTo('UNKNOWN', 'TRANSFER_UNKNOWN', ctx);
  }

  /** Solo desde COMPLETED; la transición en sí garantiza "una sola vez" (REV-02, REV-03). */
  requestReversal(reversalId: string, ctx: ChangeContext): void {
    this.transitionTo('REVERSAL_PENDING', 'TRANSFER_REVERSAL_REQUESTED', ctx);
    this.props.reversalId = reversalId;
    // El contador de intentos pasa a medir los intentos del reverso en el riel.
    this.props.attempts = 0;
    this.props.nextAttemptAt = this.props.type === 'EXTERNAL' ? ctx.now : null;
  }

  markReversed(ctx: ChangeContext): void {
    this.transitionTo('REVERSED', 'TRANSFER_REVERSED', ctx);
  }

  /** El banco rechazó el reverso: la transferencia sigue COMPLETED y se puede volver a intentar. */
  rejectReversal(reason: string, ctx: ChangeContext): void {
    this.props.reversalId = null;
    this.transitionTo('COMPLETED', 'TRANSFER_REVERSAL_REJECTED', ctx, reason);
  }

  /** Reintento con backoff exponencial; tras maxAttempts se marca para revisión manual (EXT-08). */
  scheduleRetry(now: Date, policy: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number }): void {
    const exponent = Math.max(this.props.attempts - 1, 0);
    const delay = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
    this.props.nextAttemptAt = new Date(now.getTime() + delay);
    if (this.props.attempts >= policy.maxAttempts) {
      this.props.requiresManualReview = true;
    }
    this.props.updatedAt = now;
  }

  pullEvents(): TransferEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  private transitionTo(
    next: TransferStatus,
    eventType: TransferEventType,
    ctx: ChangeContext,
    reason?: string,
  ): void {
    const previous = this.props.status;
    if (!ALLOWED_TRANSITIONS[previous].includes(next)) {
      throw new DomainError('INVALID_STATE', `No se puede pasar de ${previous} a ${next}`);
    }
    this.props.status = next;
    this.props.updatedAt = ctx.now;
    if (!RAIL_PENDING_STATUSES.includes(next)) {
      this.props.nextAttemptAt = null;
    }
    this.record(eventType, previous, ctx, reason);
  }

  private record(
    eventType: TransferEventType,
    previousStatus: TransferStatus | null,
    ctx: ChangeContext,
    reason?: string,
  ): void {
    const participants = [this.props.ownerId, this.props.counterpartyOwnerId].filter(
      (id): id is string => id !== null,
    );
    this.pendingEvents.push({
      eventType,
      transferId: this.props.id,
      occurredAt: ctx.now,
      actorId: ctx.actorId,
      participantIds: [...new Set(participants)],
      payload: {
        transferId: this.props.id,
        type: this.props.type,
        fromAccount: this.props.fromAccount,
        toAccount: this.props.toAccount,
        amount: this.props.amount.toString(),
        status: this.props.status,
        previousStatus,
        ...(reason ? { reason } : {}),
      },
    });
  }
}
