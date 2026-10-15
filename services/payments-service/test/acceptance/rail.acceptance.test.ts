import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceOf, resetData, startDatabase, type TestDatabase } from '../support/database.js';
import { FakeBankRail, type FakeSendScenario } from '../support/FakeBankRail.js';
import { createHarness, type Harness, USERS } from '../support/harness.js';

const external = (amount: string, toAccount = 'EXT-BANCO-123') => ({
  type: 'EXTERNAL',
  fromAccount: 'ACC-001',
  toAccount,
  amount,
});

describe('Transferencias externas y riel bancario (PostgreSQL real + riel falso)', () => {
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

  async function createExternal(amount = '50000.00'): Promise<string> {
    const response = await h.createTransfer(USERS.alice, external(amount));
    expect(response.statusCode).toBe(202);
    return response.json().id as string;
  }

  const statusOf = async (id: string) => (await h.get(USERS.alice, `/transfers/${id}`)).json();

  it('[EXT-01] una externa responde 202 PENDING sin esperar al riel y retiene el dinero', async () => {
    const response = await h.createTransfer(USERS.alice, external('50000.00'));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'PENDING', type: 'EXTERNAL', attempts: 0 });
    expect(rail.calls).toHaveLength(0);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-02] si el riel acepta (200) queda COMPLETED y el dinero no vuelve', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['ACCEPTED'];

    await h.worker.runOnce();

    expect(await statusOf(id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(rail.calls).toEqual([{ operation: 'send', reference: id }]);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-03] si el riel rechaza (422) queda FAILED y se reembolsa en la misma transacción', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['REJECTED'];

    await h.worker.runOnce();

    expect(await statusOf(id)).toMatchObject({ status: 'FAILED', failureReason: 'RAIL_REJECTED' });
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
  });

  it('[EXT-04] si el riel no está disponible (503) sigue PENDING y reintenta con la misma reference sin doble débito', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['UNAVAILABLE', 'ACCEPTED'];

    await h.worker.runOnce();
    const afterFirst = await statusOf(id);
    expect(afterFirst).toMatchObject({ status: 'PENDING', attempts: 1 });
    const { rows } = await db.pool.query('SELECT next_attempt_at FROM payment_schema.transfers WHERE id = $1', [id]);
    expect(rows[0].next_attempt_at).not.toBeNull();

    await h.drainRail();

    expect(await statusOf(id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(rail.calls.filter((call) => call.operation === 'send').map((call) => call.reference)).toEqual([id, id]);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-05] si el riel no responde a tiempo queda UNKNOWN (nunca FAILED) y el dinero sigue retenido', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_PROCESSED'];

    await h.worker.runOnce();

    expect((await statusOf(id)).status).toBe('UNKNOWN');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-06] una UNKNOWN se reconcilia con el GET del riel: ACCEPTED → COMPLETED sin reenviar', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_PROCESSED'];

    await h.drainRail();

    expect((await statusOf(id)).status).toBe('COMPLETED');
    expect(rail.callsFor('send')).toBe(1);
    expect(rail.callsFor('lookup')).toBe(1);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-06] una UNKNOWN que el banco rechazó termina FAILED con reembolso', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_LOST'];
    rail.lookupOverrides = ['REJECTED'];

    await h.drainRail();

    expect((await statusOf(id)).status).toBe('FAILED');
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('1000000.00');
  });

  it('[EXT-06] si la consulta falla (503/timeout) sigue UNKNOWN y no se reenvía a ciegas', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_LOST'];
    rail.lookupOverrides = ['UNAVAILABLE', 'UNKNOWN'];

    await h.worker.runOnce(); // envío → timeout
    await h.worker.runOnce(); // consulta → 503
    await h.worker.runOnce(); // consulta → timeout

    expect((await statusOf(id)).status).toBe('UNKNOWN');
    expect(rail.callsFor('send')).toBe(1);
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-07] si el banco no la conoce (404) se reenvía con la misma reference', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_LOST', 'ACCEPTED'];

    await h.drainRail();

    expect((await statusOf(id)).status).toBe('COMPLETED');
    expect(rail.calls.map((call) => call.operation)).toEqual(['send', 'lookup', 'send']);
    expect(new Set(rail.calls.map((call) => call.reference))).toEqual(new Set([id]));
  });

  it('[EXT-07] tras un intento previo siempre se consulta antes de reenviar', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['UNAVAILABLE', 'ACCEPTED'];

    await h.drainRail();

    expect((await statusOf(id)).status).toBe('COMPLETED');
    expect(rail.calls.map((call) => call.operation)).toEqual(['send', 'lookup', 'send']);
  });

  it('[EXT-08] tras N intentos sin resolución queda marcada para revisión manual, sin resolverse por suposición', async () => {
    const id = await createExternal();
    rail.sendScenarios = ['TIMEOUT_LOST'];
    rail.lookupOverrides = Array.from({ length: 10 }, () => 'UNAVAILABLE' as const);

    await h.drainRail(6);

    expect(await statusOf(id)).toMatchObject({ status: 'UNKNOWN', requiresManualReview: true });
    expect(await balanceOf(db.pool, 'ACC-001')).toBe('950000.00');
  });

  it('[EXT-08] con cualquier combinación de respuestas del riel el dinero se conserva', async () => {
    const scenarios: FakeSendScenario[] = ['ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'TIMEOUT_PROCESSED', 'TIMEOUT_LOST'];
    for (let i = 0; i < 20; i++) {
      const response = await h.createTransfer(USERS.alice, external(`${1000 + i}.25`, `EXT-${i}`));
      expect(response.statusCode).toBe(202);
    }
    // Secuencia pseudoaleatoria determinista para que el test sea reproducible.
    rail.sendScenarios = Array.from({ length: 200 }, (_, i) => scenarios[(i * 7 + 3) % scenarios.length]!);

    const assertConservation = async () => {
      const { rows } = await db.pool.query<{ total: string }>(`
        SELECT (SELECT sum(balance) FROM payment_schema.accounts)
             + (SELECT coalesce(sum(amount), 0) FROM payment_schema.transfers
                 WHERE type = 'EXTERNAL' AND status IN ('PENDING', 'UNKNOWN', 'COMPLETED', 'REVERSAL_PENDING')) AS total`);
      expect(rows[0]!.total).toBe('1500000.00');
    };

    for (let cycle = 0; cycle < 8; cycle++) {
      await h.worker.runOnce();
      await assertConservation();
    }
  });
});
