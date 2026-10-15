import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceOf, resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail } from '../support/FakeBankRail.js';
import { createHarness, type Harness, tokenFor, USERS } from '../support/harness.js';

describe('Payment links (PostgreSQL real)', () => {
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

  const createLink = (user: string, body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: '/payment-links',
      headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: body,
    });

  const pay = (user: string, linkId: string, fromAccount: string, idempotencyKey = randomUUID()) =>
    h.app.inject({
      method: 'POST',
      url: `/payment-links/${linkId}/pay`,
      headers: { authorization: `Bearer ${tokenFor(user)}`, 'idempotency-key': idempotencyKey },
      payload: { fromAccount },
    });

  async function aliceLink(amount = '25000.00'): Promise<string> {
    const response = await createLink(USERS.alice, { accountId: 'ACC-001', amount, description: 'Factura 123' });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it('[PL-01] el dueño de la cuenta crea un link ACTIVE que vence en 24 h', async () => {
    const before = Date.now();
    const response = await createLink(USERS.alice, { accountId: 'ACC-001', amount: '25000.5', description: 'Factura 123' });

    expect(response.statusCode).toBe(201);
    const link = response.json();
    expect(link).toMatchObject({ accountId: 'ACC-001', amount: '25000.50', status: 'ACTIVE', paidTransferId: null });
    const ttl = new Date(link.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600 * 1000 + 5000);
  });

  it('[PL-01] monto inválido 422, cuenta ajena 403, descripción vacía o larga 400', async () => {
    const invalidAmount = await createLink(USERS.alice, { accountId: 'ACC-001', amount: '0', description: 'x' });
    const foreign = await createLink(USERS.alice, { accountId: 'ACC-002', amount: '10.00', description: 'x' });
    const empty = await createLink(USERS.alice, { accountId: 'ACC-001', amount: '10.00', description: '   ' });
    const tooLong = await createLink(USERS.alice, { accountId: 'ACC-001', amount: '10.00', description: 'x'.repeat(141) });

    expect([invalidAmount.statusCode, invalidAmount.json().code]).toEqual([422, 'INVALID_AMOUNT']);
    expect([foreign.statusCode, foreign.json().code]).toEqual([403, 'FORBIDDEN_ACCOUNT']);
    expect(empty.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
  });

  it('[PL-02] cualquiera ve el link sin token, sin datos del dueño; uno inexistente da 404', async () => {
    const id = await aliceLink();

    const response = await h.app.inject({ method: 'GET', url: `/payment-links/${id}/public` });
    const missing = await h.app.inject({ method: 'GET', url: `/payment-links/${randomUUID()}/public` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id,
      accountId: 'ACC-001',
      amount: '25000.00',
      currency: 'COP',
      description: 'Factura 123',
      status: 'ACTIVE',
      expiresAt: expect.any(String),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('[PL-03] un tercero paga el link: transferencia interna COMPLETED y link PAID en la misma transacción', async () => {
    const id = await aliceLink();

    const response = await pay(USERS.bob, id, 'ACC-002');

    expect(response.statusCode).toBe(201);
    const transfer = response.json();
    expect(transfer).toMatchObject({
      type: 'INTERNAL',
      fromAccount: 'ACC-002',
      toAccount: 'ACC-001',
      amount: '25000.00',
      status: 'COMPLETED',
    });
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('475000.00');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1025000.00');
    const links = (await h.get(USERS.alice, '/payment-links?account=ACC-001')).json();
    expect(links[0]).toMatchObject({ id, status: 'PAID', paidTransferId: transfer.id });
    const { rows } = await db.pool.query('SELECT event_type FROM payment_schema.outbox WHERE aggregate_id = $1 ORDER BY seq', [
      transfer.id,
    ]);
    expect(rows.map((row) => row.event_type)).toEqual(['TRANSFER_CREATED', 'TRANSFER_COMPLETED']);
  });

  it('[PL-04] un link se paga una sola vez, también con pagos concurrentes', async () => {
    const id = await aliceLink('1000.00');

    const responses = await Promise.all([
      pay(USERS.bob, id, 'ACC-002'),
      pay(USERS.bob, id, 'ACC-002'),
      pay(USERS.bob, id, 'ACC-002'),
    ]);
    const later = await pay(USERS.bob, id, 'ACC-002');

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(2);
    expect([later.statusCode, later.json().code]).toEqual([409, 'INVALID_STATE']);
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('499000.00');
  });

  it('[PL-04] repetir el pago con la misma key reproduce la respuesta', async () => {
    const id = await aliceLink('1000.00');
    const key = randomUUID();

    const first = await pay(USERS.bob, id, 'ACC-002', key);
    const retry = await pay(USERS.bob, id, 'ACC-002', key);

    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('499000.00');
  });

  it('[PL-05] link vencido, saldo insuficiente, cuenta ajena o misma cuenta se rechazan sin mover dinero', async () => {
    const expired = await aliceLink('10.00');
    await db.pool.query("UPDATE payment_schema.payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expired,
    ]);
    const active = await aliceLink('10.00');

    const expiredResponse = await pay(USERS.bob, expired, 'ACC-002');
    const noFunds = await pay(USERS.carol, active, 'ACC-003');
    const foreignAccount = await pay(USERS.bob, active, 'ACC-003');
    const sameAccount = await pay(USERS.alice, active, 'ACC-001');

    expect([expiredResponse.statusCode, expiredResponse.json().code]).toEqual([422, 'PAYMENT_LINK_EXPIRED']);
    expect([noFunds.statusCode, noFunds.json().code]).toEqual([422, 'INSUFFICIENT_FUNDS']);
    expect([foreignAccount.statusCode, foreignAccount.json().code]).toEqual([403, 'FORBIDDEN_ACCOUNT']);
    expect([sameAccount.statusCode, sameAccount.json().code]).toEqual([422, 'SAME_ACCOUNT']);
    const status = (await h.app.inject({ method: 'GET', url: `/payment-links/${active}/public` })).json().status;
    expect(status).toBe('ACTIVE');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
  });

  it('[PL-06] el dueño lista sus links, más recientes primero, con EXPIRED derivado', async () => {
    const older = await aliceLink('1.00');
    const newer = await aliceLink('2.00');
    await db.pool.query("UPDATE payment_schema.payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      older,
    ]);

    const response = await h.get(USERS.alice, '/payment-links?account=ACC-001');
    const foreign = await h.get(USERS.bob, '/payment-links?account=ACC-001');

    expect(response.json().map((link: { id: string; status: string }) => [link.id, link.status])).toEqual([
      [newer, 'ACTIVE'],
      [older, 'EXPIRED'],
    ]);
    expect(foreign.statusCode).toBe(403);
  });
});
