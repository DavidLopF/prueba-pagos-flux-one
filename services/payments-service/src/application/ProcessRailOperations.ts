import type { Transfer } from '../domain/model/Transfer.js';
import type { BankRail, RailSendResult } from '../domain/ports/BankRail.js';
import type { TransactionContext, UnitOfWork } from '../domain/ports/repositories.js';
import type { Clock } from '../domain/ports/system.js';

export interface RailWorkerPolicy {
  batchSize: number;
  /** Tiempo durante el cual una transferencia reclamada no la toma otro worker (> 2 × timeout del riel). */
  leaseMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A partir de este número de intentos se marca requiresManualReview (sigue reintentando). */
  maxAttempts: number;
}

/** UNKNOWN_LOOKUP: no se pudo consultar al banco; no sabemos nada nuevo y no se reenvía a ciegas. */
type RailOutcome = RailSendResult | 'UNKNOWN_LOOKUP';

/**
 * Worker del riel bancario (EXT-02..08, REV-05).
 * 1. Reclama transferencias PENDING / UNKNOWN / REVERSAL_PENDING (transacción corta, con lease).
 * 2. Llama al riel FUERA de cualquier transacción (puede tardar hasta el timeout).
 * 3. Aplica el resultado en una transacción nueva: estado + reembolso + eventos del outbox.
 */
export class ProcessRailOperations {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly rail: BankRail,
    private readonly clock: Clock,
    private readonly policy: RailWorkerPolicy,
  ) {}

  /** Un ciclo del worker. Devuelve cuántas transferencias procesó. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.uow.run((tx) =>
      tx.transfers.claimDueForRail(now, new Date(now.getTime() + this.policy.leaseMs), this.policy.batchSize),
    );
    const results = await Promise.allSettled(claimed.map((transfer) => this.process(transfer)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      // Lo que falló se reintenta solo cuando vence el lease; se propaga para que quede en el log.
      throw failure.reason;
    }
    return claimed.length;
  }

  private async process(claimed: Transfer): Promise<void> {
    const outcome =
      claimed.status === 'REVERSAL_PENDING' ? await this.sendReversal(claimed) : await this.sendTransfer(claimed);
    await this.apply(claimed, outcome);
  }

  private sendTransfer(transfer: Transfer): Promise<RailOutcome> {
    return this.lookupThenSend(transfer.id, transfer.mayHaveReachedRail(), () =>
      this.rail.sendTransfer({
        reference: transfer.id,
        from: transfer.fromAccount,
        to: transfer.toAccount,
        amount: transfer.amount,
      }),
    );
  }

  private sendReversal(transfer: Transfer): Promise<RailOutcome> {
    const reference = transfer.reversalId;
    if (!reference) {
      throw new Error(`La transferencia ${transfer.id} está en REVERSAL_PENDING sin reversalId`);
    }
    return this.lookupThenSend(reference, transfer.mayHaveReachedRail(), () =>
      this.rail.sendReversal({ reference, originalReference: transfer.id, amount: transfer.amount }),
    );
  }

  /** Consultar antes de reenviar (CLAUDE.md §3, EXT-07): solo se reenvía si el banco no la conoce. */
  private async lookupThenSend(
    reference: string,
    mayHaveReachedRail: boolean,
    send: () => Promise<RailSendResult>,
  ): Promise<RailOutcome> {
    if (mayHaveReachedRail) {
      const found = await this.rail.lookup(reference);
      if (found === 'ACCEPTED' || found === 'REJECTED') return found;
      if (found !== 'NOT_FOUND') return 'UNKNOWN_LOOKUP';
    }
    return send();
  }

  private apply(claimed: Transfer, outcome: RailOutcome): Promise<void> {
    return this.uow.run(async (tx) => {
      const transfer = await tx.transfers.findByIdForUpdate(claimed.id);
      if (!transfer || transfer.status !== claimed.status) {
        return; // Otro proceso ya la resolvió (p. ej. venció el lease): no se aplica dos veces.
      }
      const now = this.clock.now();
      const ctx = { now, actorId: null };
      const previousStatus = transfer.status;

      if (previousStatus === 'REVERSAL_PENDING') {
        if (outcome === 'ACCEPTED') {
          await this.refund(tx, transfer);
          transfer.markReversed(ctx);
        } else if (outcome === 'REJECTED') {
          transfer.rejectReversal('RAIL_REJECTED', ctx);
        } else {
          transfer.scheduleRetry(now, this.policy);
        }
      } else if (outcome === 'ACCEPTED') {
        transfer.markCompleted(ctx);
      } else if (outcome === 'REJECTED') {
        await this.refund(tx, transfer);
        transfer.markFailed('RAIL_REJECTED', ctx);
      } else {
        // UNAVAILABLE: no se procesó, sigue igual. UNKNOWN: pudo procesarse → UNKNOWN, nunca FAILED.
        if (outcome === 'UNKNOWN' && previousStatus === 'PENDING') {
          transfer.markUnknown(ctx);
        }
        transfer.scheduleRetry(now, this.policy);
      }

      await tx.transfers.update(transfer, previousStatus);
      await tx.outbox.append(transfer.pullEvents());
    });
  }

  /** Devuelve al origen el dinero retenido (rechazo del riel o reverso externo aceptado). */
  private async refund(tx: TransactionContext, transfer: Transfer): Promise<void> {
    const [source] = await tx.accounts.lockByIds([transfer.fromAccount]);
    if (!source) {
      throw new Error(`La cuenta ${transfer.fromAccount} no existe`);
    }
    source.credit(transfer.amount);
    await tx.accounts.saveBalance(source);
  }
}
