import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { Money } from '../../src/domain/model/Money.js';

describe('Money (centavos con bigint)', () => {
  it('[TR-01] suma y resta sin errores de punto flotante', () => {
    const balance = Money.fromString('1000000.00');

    expect(balance.subtract(Money.fromString('100000.50')).toString()).toBe('899999.50');
    expect(Money.fromString('0.10').add(Money.fromString('0.20')).toString()).toBe('0.30');
    expect(Money.fromString('100.5').toString()).toBe('100.50');
  });

  it.each(['-5', 'abc', '', '1e3', '1.', '.5', ' 10', '10,50'])('[TR-02] "%s" no es un monto válido', (raw) => {
    expect(() => Money.fromString(raw)).toThrowError(DomainError);
  });

  it('[TR-02] cero es un Money válido pero no positivo (la transferencia lo rechaza)', () => {
    expect(Money.fromString('0').isPositive()).toBe(false);
    expect(Money.fromString('0.01').isPositive()).toBe(true);
  });

  it('[TR-03] más de dos decimales se rechaza', () => {
    expect(() => Money.fromString('10.001')).toThrowError(/2 decimales/);
  });

  it('[TR-04] restar más de lo disponible lanza INSUFFICIENT_FUNDS y nunca da negativo', () => {
    const attempt = () => Money.fromString('10.00').subtract(Money.fromString('10.01'));

    expect(attempt).toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
    expect(Money.fromString('10.00').subtract(Money.fromString('10.00')).toString()).toBe('0.00');
  });
});
