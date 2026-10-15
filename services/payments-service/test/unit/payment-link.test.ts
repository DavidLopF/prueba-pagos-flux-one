import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/model/Money.js';
import { PAYMENT_LINK_TTL_MS, PaymentLink } from '../../src/domain/model/PaymentLink.js';

const now = new Date('2026-10-15T14:00:00.000Z');
const link = () =>
  PaymentLink.create({
    id: 'l-1',
    accountId: 'ACC-001',
    ownerId: '11111111-1111-1111-1111-111111111111',
    amount: Money.fromString('25000.00'),
    description: 'Factura 123',
    now,
  });

describe('PaymentLink', () => {
  it('[PL-01] nace ACTIVE y vence a las 24 h; el monto debe ser positivo', () => {
    expect(link().statusAt(now)).toBe('ACTIVE');
    expect(link().expiresAt.getTime() - now.getTime()).toBe(PAYMENT_LINK_TTL_MS);
    expect(() =>
      PaymentLink.create({ id: 'x', accountId: 'A', ownerId: 'o', amount: Money.fromString('0'), description: 'd', now }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
  });

  it('[PL-04] se paga una sola vez', () => {
    const paymentLink = link();
    paymentLink.markPaid('t-1', now);

    expect(paymentLink.statusAt(now)).toBe('PAID');
    expect(paymentLink.paidTransferId).toBe('t-1');
    expect(() => paymentLink.markPaid('t-2', now)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('[PL-05] un link vencido no se puede pagar', () => {
    const later = new Date(now.getTime() + PAYMENT_LINK_TTL_MS);

    expect(link().statusAt(later)).toBe('EXPIRED');
    expect(() => link().markPaid('t-1', later)).toThrowError(expect.objectContaining({ code: 'PAYMENT_LINK_EXPIRED' }));
  });
});
