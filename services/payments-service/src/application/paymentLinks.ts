import { DomainError } from '../domain/errors.js';
import type { Account } from '../domain/model/Account.js';
import { Money } from '../domain/model/Money.js';
import { PaymentLink, type PaymentLinkVisibleStatus } from '../domain/model/PaymentLink.js';
import type { UnitOfWork } from '../domain/ports/repositories.js';
import type { Clock, IdGenerator } from '../domain/ports/system.js';
import { executeTransfer } from './executeTransfer.js';
import { type IdempotentResult, type TransferView, toTransferView } from './views.js';

/** Vista pública (PL-02): sin dueño ni transferencia de pago. */
export interface PublicPaymentLinkView {
  id: string;
  accountId: string;
  amount: string;
  currency: 'COP';
  description: string;
  status: PaymentLinkVisibleStatus;
  expiresAt: string;
}

export interface PaymentLinkView extends PublicPaymentLinkView {
  paidTransferId: string | null;
  createdAt: string;
}

const toPublicView = (link: PaymentLink, now: Date): PublicPaymentLinkView => ({
  id: link.id,
  accountId: link.accountId,
  amount: link.amount.toString(),
  currency: 'COP',
  description: link.description,
  status: link.statusAt(now),
  expiresAt: link.expiresAt.toISOString(),
});

const toView = (link: PaymentLink, now: Date): PaymentLinkView => ({
  ...toPublicView(link, now),
  paidTransferId: link.paidTransferId,
  createdAt: link.createdAt.toISOString(),
});

/** Casos de uso de los links de cobro (docs/spec.md §11). */
export class PaymentLinks {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** PL-01 */
  create(command: { userId: string; accountId: string; amount: string; description: string }): Promise<PaymentLinkView> {
    const amount = Money.fromString(command.amount);
    return this.uow.run(async (tx) => {
      const account = await tx.accounts.findById(command.accountId);
      if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', `La cuenta ${command.accountId} no existe`);
      account.assertOwnedBy(command.userId);
      const now = this.clock.now();
      const link = PaymentLink.create({
        id: this.ids.newId(),
        accountId: account.id,
        ownerId: command.userId,
        amount,
        description: command.description,
        now,
      });
      await tx.paymentLinks.insert(link);
      return toView(link, now);
    });
  }

  /** PL-02: sin autenticación; el id (UUID aleatorio) funciona como URL de capacidad. */
  getPublic(linkId: string): Promise<PublicPaymentLinkView> {
    return this.uow.run(async (tx) => {
      const link = await tx.paymentLinks.findById(linkId);
      if (!link) throw new DomainError('NOT_FOUND', 'Link de pago no encontrado');
      return toPublicView(link, this.clock.now());
    });
  }

  /** PL-06 */
  listByAccount(userId: string, accountId: string): Promise<PaymentLinkView[]> {
    return this.uow.run(async (tx) => {
      ownAccount(await tx.accounts.findById(accountId), userId);
      const now = this.clock.now();
      return (await tx.paymentLinks.listByAccount(accountId)).map((link) => toView(link, now));
    });
  }

  /**
   * PL-03..05. Una transacción: key de idempotencia → link bloqueado (FOR UPDATE) → transferencia interna
   * con las reglas de siempre → link PAID. Dos pagos concurrentes se serializan en el lock del link.
   */
  pay(command: {
    userId: string;
    idempotencyKey: string;
    linkId: string;
    fromAccount: string;
  }): Promise<IdempotentResult<TransferView>> {
    const fingerprint = JSON.stringify(['PAY_PAYMENT_LINK', command.linkId, command.fromAccount]);
    return this.uow.run(async (tx) => {
      const idempotency = await tx.idempotency.begin(command.userId, command.idempotencyKey, fingerprint);
      if (idempotency.kind === 'MISMATCH') {
        throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó con otro payload');
      }
      if (idempotency.kind === 'REPLAY') {
        return { result: idempotency.response as TransferView, replayed: true };
      }

      const link = await tx.paymentLinks.findByIdForUpdate(command.linkId);
      if (!link) throw new DomainError('NOT_FOUND', 'Link de pago no encontrado');
      const now = this.clock.now();
      link.assertPayable(now);

      const transfer = await executeTransfer(tx, {
        id: this.ids.newId(),
        userId: command.userId,
        type: 'INTERNAL',
        fromAccount: command.fromAccount,
        toAccount: link.accountId,
        amount: link.amount,
        now,
      });
      link.markPaid(transfer.id, now);
      if (!(await tx.paymentLinks.markPaid(link))) {
        throw new DomainError('INVALID_STATE', 'El link ya fue pagado');
      }

      const view = toTransferView(transfer);
      await tx.idempotency.complete(command.userId, command.idempotencyKey, view);
      return { result: view, replayed: false };
    });
  }
}

function ownAccount(account: Account | null, userId: string): Account {
  if (!account) throw new DomainError('NOT_FOUND', 'Cuenta no encontrada');
  account.assertOwnedBy(userId);
  return account;
}
