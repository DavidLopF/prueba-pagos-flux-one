import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceOf, resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail } from '../support/FakeBankRail.js';
import { createHarness, type Harness, USERS } from '../support/harness.js';

describe('Reversos (PostgreSQL real + riel falso)', () => {
  let db: TestDatabase;
  let rail: FakeBankRail;
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
    rail = new FakeBankRail();
    h = createHarness(db.pool, rail);
  });

  async function completedInternal(amount = '100000.00'): Promise<string> {
    const response = await h.createTransfer(USERS.alice, {
      type: 'INTERNAL',
      fromAccount: 'ACC-001',
      toAccount: 'ACC-002',
      amount,
    });
    expect(response.json().status).toBe('COMPLETED');
    return response.json().id as string;
  }

  async function completedExternal(amount = '50000.00'): Promise<string> {
    const response = await h.createTransfer(USERS.alice, {
      type: 'EXTERNAL',
      fromAccount: 'ACC-001',
      toAccount: 'EXT-BANCO-123',
      amount,
    });
    rail.sendScenarios = ['ACCEPTED'];
    await h.drainRail();
    return response.json().id as string;
  }

  const statusOf = async (id: string) => (await h.get(USERS.alice, `/transfers/${id}`)).json();

  it('[REV-01] el reverso de una interna completada devuelve el dinero en una sola transacción', async () => {
    const id = await completedInternal();

    const response = await h.reverse(USERS.alice, id);

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('REVERSED');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('500000.00');
  });

  it('[REV-02] solo se reversan transferencias completadas', async () => {
    const pending = (
      await h.createTransfer(USERS.alice, { type: 'EXTERNAL', fromAccount: 'ACC-001', toAccount: 'EXT-1', amount: '10.00' })
    ).json().id as string;
    const failed = (
      await h.createTransfer(USERS.alice, { type: 'EXTERNAL', fromAccount: 'ACC-001', toAccount: 'EXT-2', amount: '10.00' })
    ).json().id as string;
    rail.sendScenarios = ['UNAVAILABLE', 'REJECTED'];
    await h.worker.runOnce();
    // Según el orden de procesamiento, una quedó PENDING y la otra FAILED.
    const statuses = [(await statusOf(pending)).status, (await statusOf(failed)).status].sort();
    expect(statuses).toEqual(['FAILED', 'PENDING']);

    for (const id of [pending, failed]) {
      const response = await h.reverse(USERS.alice, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('INVALID_STATE');
    }
  });

  it('[REV-03] una transferencia se reversa una sola vez, también con requests concurrentes', async () => {
    const id = await completedInternal();

    const responses = await Promise.all(Array.from({ length: 5 }, () => h.reverse(USERS.alice, id)));
    const again = await h.reverse(USERS.alice, id);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(4);
    expect(again.statusCode).toBe(409);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('500000.00');
  });

  it('[REV-04] si el destino ya gastó el dinero el reverso se rechaza y nada queda negativo', async () => {
    const id = await completedInternal('100000.00');
    // bob gasta todo su saldo (600.000) antes del reverso.
    await h.createTransfer(USERS.bob, { type: 'INTERNAL', fromAccount: 'ACC-002', toAccount: 'ACC-003', amount: '600000.00' });

    const response = await h.reverse(USERS.alice, id);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('INSUFFICIENT_FUNDS');
    expect((await statusOf(id)).status).toBe('COMPLETED');
    expect(await balanceOf(db.pool, 'ACC-002')).toBe('0.00');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('900000.00');
  });

  it('[REV-05] el reverso de una externa queda REVERSAL_PENDING y con 200 del riel pasa a REVERSED con reembolso', async () => {
    const id = await completedExternal();
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');

    const response = await h.reverse(USERS.alice, id);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('REVERSAL_PENDING');

    rail.reversalScenarios = ['ACCEPTED'];
    await h.drainRail();

    expect((await statusOf(id)).status).toBe('REVERSED');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
    const reversal = rail.calls.find((call) => call.operation === 'reverse');
    expect(reversal?.reference).not.toBe(id); // el reverso tiene su propia reference
  });

  it('[REV-05] si el riel rechaza el reverso vuelve a COMPLETED sin mover dinero', async () => {
    const id = await completedExternal();
    await h.reverse(USERS.alice, id);

    rail.reversalScenarios = ['REJECTED'];
    await h.drainRail();

    expect((await statusOf(id)).status).toBe('COMPLETED');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[REV-05] con 503 o timeout el reverso sigue pendiente y se reconcilia sin reembolsar dos veces', async () => {
    const id = await completedExternal();
    await h.reverse(USERS.alice, id);

    rail.reversalScenarios = ['UNAVAILABLE', 'TIMEOUT_PROCESSED'];
    await h.worker.runOnce(); // 503
    expect((await statusOf(id)).status).toBe('REVERSAL_PENDING');
    await h.worker.runOnce(); // consulta 404 → reenvía → timeout (el banco sí lo procesó)
    expect((await statusOf(id)).status).toBe('REVERSAL_PENDING');
    await h.drainRail(); // consulta → ACCEPTED

    expect((await statusOf(id)).status).toBe('REVERSED');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
  });

  it('[REV-06] repetir el reverso con la misma key reproduce la respuesta en vez de 409', async () => {
    const id = await completedInternal();
    const key = randomUUID();

    const first = await h.reverse(USERS.alice, id, key);
    const retry = await h.reverse(USERS.alice, id, key);

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
  });

  it('[AUTH-06] solo el dueño de la cuenta origen puede reversar', async () => {
    const id = await completedInternal();

    const response = await h.reverse(USERS.bob, id);

    expect(response.statusCode).toBe(404);
    expect((await statusOf(id)).status).toBe('COMPLETED');
  });
});
