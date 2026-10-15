import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceOf, countRows, resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail } from '../support/FakeBankRail.js';
import { createHarness, type Harness, tokenFor, USERS } from '../support/harness.js';

const internal = (amount: string, fromAccount = 'ACC-001', toAccount = 'ACC-002') => ({
  type: 'INTERNAL',
  fromAccount,
  toAccount,
  amount,
});

describe('Transferencias, idempotencia y saldos (PostgreSQL real)', () => {
  let db: TestDatabase;
  let h: Harness;

  beforeAll(async () => {
    db = await startDatabase();
  });
  afterAll(async () => {
    await h?.app.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await resetData(db.pool);
    h = createHarness(db.pool, new FakeBankRail());
  });

  describe('TR: creación', () => {
    it('[TR-01] una transferencia interna debita y acredita en la misma transacción y queda COMPLETED', async () => {
      const response = await h.createTransfer(USERS.alice, internal('100000.50'));

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ status: 'COMPLETED', amount: '100000.50', currency: 'COP' });
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('899999.50');
      expect(await balanceOf(db.pool, 'ACC-002')).toBe('600000.50');
    });

    it.each(['0', '0.00', '-5', 'abc', '', '1e3'])('[TR-02] el monto "%s" se rechaza con 422 INVALID_AMOUNT', async (amount) => {
      const response = await h.createTransfer(USERS.alice, internal(amount));

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('INVALID_AMOUNT');
      expect(await countRows(db.pool, 'transfers')).toBe(0);
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
    });

    it('[TR-03] un monto con más de dos decimales se rechaza', async () => {
      const response = await h.createTransfer(USERS.alice, internal('10.001'));

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('INVALID_AMOUNT');
    });

    it('[TR-04] con saldo insuficiente se rechaza y ningún saldo cambia', async () => {
      const response = await h.createTransfer(USERS.carol, internal('1.00', 'ACC-003', 'ACC-001'));

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(db.pool, 'ACC-003')).toBe('0.00');
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
      expect(await countRows(db.pool, 'transfers')).toBe(0);
    });

    it('[TR-04] el saldo nunca queda negativo: se puede transferir exactamente todo el saldo', async () => {
      const response = await h.createTransfer(USERS.bob, internal('500000.00', 'ACC-002', 'ACC-003'));

      expect(response.statusCode).toBe(201);
      expect(await balanceOf(db.pool, 'ACC-002')).toBe('0.00');
    });

    it('[TR-05] origen igual a destino se rechaza', async () => {
      const response = await h.createTransfer(USERS.alice, internal('10.00', 'ACC-001', 'ACC-001'));

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('SAME_ACCOUNT');
    });

    it('[TR-06] una cuenta origen o destino inexistente se rechaza sin movimientos', async () => {
      const unknownSource = await h.createTransfer(USERS.alice, internal('10.00', 'ACC-999', 'ACC-002'));
      const unknownDestination = await h.createTransfer(USERS.alice, internal('10.00', 'ACC-001', 'ACC-999'));

      expect(unknownSource.statusCode).toBe(422);
      expect(unknownSource.json().code).toBe('ACCOUNT_NOT_FOUND');
      expect(unknownDestination.statusCode).toBe(422);
      expect(unknownDestination.json().code).toBe('ACCOUNT_NOT_FOUND');
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
    });

    it('[TR-07] sin Idempotency-Key se responde 400', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/transfers',
        headers: { authorization: `Bearer ${tokenFor(USERS.alice)}` },
        payload: internal('10.00'),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('[TR-07] el reverso sin Idempotency-Key también se responde 400', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: `/transfers/${randomUUID()}/reversal`,
        headers: { authorization: `Bearer ${tokenFor(USERS.alice)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('TR/BAL: consultas', () => {
    it('[TR-08] el emisor y el receptor pueden consultar la transferencia; un tercero recibe 404', async () => {
      const { id } = (await h.createTransfer(USERS.alice, internal('10.00'))).json();

      const asOwner = await h.get(USERS.alice, `/transfers/${id}`);
      expect(asOwner.statusCode).toBe(200);
      expect(asOwner.json()).toMatchObject({
        id,
        type: 'INTERNAL',
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '10.00',
        status: 'COMPLETED',
      });
      expect((await h.get(USERS.bob, `/transfers/${id}`)).statusCode).toBe(200);
      expect((await h.get(USERS.carol, `/transfers/${id}`)).statusCode).toBe(404);
      expect((await h.get(USERS.alice, `/transfers/${randomUUID()}`)).statusCode).toBe(404);
    });

    it('[TR-09] el historial de una cuenta incluye enviadas y recibidas, de la más reciente a la más antigua', async () => {
      const first = (await h.createTransfer(USERS.alice, internal('1.00'))).json();
      const second = (await h.createTransfer(USERS.bob, internal('2.00', 'ACC-002', 'ACC-001'))).json();

      const response = await h.get(USERS.alice, '/transfers?account=ACC-001');

      expect(response.statusCode).toBe(200);
      expect(response.json().map((t: { id: string }) => t.id)).toEqual([second.id, first.id]);
    });

    it('[BAL-01] se consulta el saldo de una cuenta propia', async () => {
      const response = await h.get(USERS.alice, '/accounts/ACC-001/balance');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accountId: 'ACC-001', balance: '1000000.00', currency: 'COP' });
      expect((await h.get(USERS.alice, '/accounts')).json()).toEqual([
        { accountId: 'ACC-001', balance: '1000000.00', currency: 'COP' },
      ]);
    });
  });

  describe('AUTH: protección y propiedad de cuentas', () => {
    it('[AUTH-04] sin token, con firma inválida o vencido se responde 401; /health es público', async () => {
      const noToken = await h.app.inject({ method: 'GET', url: '/accounts' });
      const badSignature = await h.app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { authorization: `Bearer ${tokenFor(USERS.alice, { secret: 'otro-secreto' })}` },
      });
      const expired = await h.app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { authorization: `Bearer ${tokenFor(USERS.alice, { expiresIn: -10 })}` },
      });

      for (const response of [noToken, badSignature, expired]) {
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('UNAUTHORIZED');
      }
      expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });

    it('[AUTH-06] no se puede transferir desde ni consultar una cuenta ajena', async () => {
      const transfer = await h.createTransfer(USERS.alice, internal('10.00', 'ACC-002', 'ACC-001'));
      const balance = await h.get(USERS.alice, '/accounts/ACC-002/balance');
      const history = await h.get(USERS.alice, '/transfers?account=ACC-002');

      expect(transfer.statusCode).toBe(403);
      expect(transfer.json().code).toBe('FORBIDDEN_ACCOUNT');
      expect(balance.statusCode).toBe(403);
      expect(history.statusCode).toBe(403);
      expect(await balanceOf(db.pool, 'ACC-002')).toBe('500000.00');
    });
  });

  describe('IDEM: idempotencia', () => {
    it('[IDEM-01] un reintento con la misma key reproduce la respuesta y debita una sola vez', async () => {
      const key = randomUUID();
      const first = await h.createTransfer(USERS.alice, internal('100.00'), key);
      const retry = await h.createTransfer(USERS.alice, internal('100.00'), key);

      expect(retry.statusCode).toBe(first.statusCode);
      expect(retry.json()).toEqual(first.json());
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('999900.00');
      expect(await countRows(db.pool, 'transfers')).toBe(1);
    });

    it('[IDEM-01] "100.5" y "100.50" son el mismo payload', async () => {
      const key = randomUUID();
      await h.createTransfer(USERS.alice, internal('100.5'), key);
      const retry = await h.createTransfer(USERS.alice, internal('100.50'), key);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await countRows(db.pool, 'transfers')).toBe(1);
    });

    it('[IDEM-02] 10 requests concurrentes con la misma key producen una sola transferencia y un solo débito', async () => {
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => h.createTransfer(USERS.alice, internal('1000.00'), key)),
      );

      const ids = new Set(responses.map((response) => response.json().id));
      expect(responses.every((response) => response.statusCode === 201)).toBe(true);
      expect(ids.size).toBe(1);
      expect(responses.filter((response) => response.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
      expect(await countRows(db.pool, 'transfers')).toBe(1);
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('999000.00');
      expect(await balanceOf(db.pool, 'ACC-002')).toBe('501000.00');
    });

    it('[TR-04] requests concurrentes con keys distintas no sobregiran la cuenta', async () => {
      // 10 × 60.000 = 600.000 > 500.000 de ACC-002: como mucho 8 pueden pasar.
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => h.createTransfer(USERS.bob, internal('60000.00', 'ACC-002', 'ACC-003'))),
      );

      const accepted = responses.filter((response) => response.statusCode === 201).length;
      expect(accepted).toBe(8);
      expect(await balanceOf(db.pool, 'ACC-002')).toBe('20000.00');
      expect(await balanceOf(db.pool, 'ACC-003')).toBe('480000.00');
    });

    it('[IDEM-03] la misma key con un payload distinto se rechaza con 422', async () => {
      const key = randomUUID();
      await h.createTransfer(USERS.alice, internal('100.00'), key);
      const otherAmount = await h.createTransfer(USERS.alice, internal('200.00'), key);
      const otherDestination = await h.createTransfer(USERS.alice, internal('100.00', 'ACC-001', 'ACC-003'), key);

      for (const response of [otherAmount, otherDestination]) {
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(await balanceOf(db.pool, 'ACC-001')).toBe('999900.00');
    });

    it('[IDEM-04] la key se aísla por usuario', async () => {
      const key = randomUUID();
      const fromAlice = await h.createTransfer(USERS.alice, internal('5.00', 'ACC-001', 'ACC-003'), key);
      const fromBob = await h.createTransfer(USERS.bob, internal('5.00', 'ACC-002', 'ACC-003'), key);

      expect(fromAlice.statusCode).toBe(201);
      expect(fromBob.statusCode).toBe(201);
      expect(fromBob.headers['idempotent-replayed']).toBeUndefined();
      expect(await balanceOf(db.pool, 'ACC-003')).toBe('10.00');
    });
  });
});
