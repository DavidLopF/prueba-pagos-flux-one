import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { COIN, DICE, LOOKUP, draws } from './dice.js';

const DELAY_MS = 50;

function startApp(values: number[], timeoutDelayMs = DELAY_MS) {
  const app = buildApp({ random: draws(...values), timeoutDelayMs });
  onTestFinished(() => app.close());
  return app;
}

const transfer = (overrides: Record<string, unknown> = {}) => ({
  reference: 'T-1',
  from: 'ACC-001',
  to: 'EXT-BANCO-123',
  amount: '50000.00',
  ...overrides,
});

describe('HTTP del riel', () => {
  it('[RAIL-01] POST /rail/transfers responde 200, 422 o 503 según el dado', async () => {
    const app = startApp([DICE.ACCEPT, DICE.REJECT, DICE.UNAVAILABLE]);
    const post = (reference: string) => app.inject({ method: 'POST', url: '/rail/transfers', payload: transfer({ reference }) });

    const accepted = await post('T-1');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ reference: 'T-1', status: 'ACCEPTED' });

    const rejected = await post('T-2');
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({ reference: 'T-2', status: 'REJECTED', reason: 'REJECTED_BY_BANK' });

    const unavailable = await post('T-3');
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'UNAVAILABLE' });
  });

  it('[RAIL-01] timeout: la respuesta sale después de RAIL_TIMEOUT_DELAY_MS', async () => {
    const app = startApp([DICE.TIMEOUT, COIN.PROCESSED]);
    const startedAt = performance.now();
    const res = await app.inject({ method: 'POST', url: '/rail/transfers', payload: transfer() });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(DELAY_MS - 5); // margen por la granularidad de los timers
    expect(res.statusCode).toBe(200);
  });

  it.each([
    { name: 'falta un campo', url: '/rail/transfers', payload: { reference: 'T-1', from: 'ACC-001', amount: '1.00' } },
    { name: 'monto como number', url: '/rail/transfers', payload: transfer({ amount: 100 }) },
    { name: 'monto con 3 decimales', url: '/rail/transfers', payload: transfer({ amount: '1.001' }) },
    { name: 'monto cero', url: '/rail/transfers', payload: transfer({ amount: '0.00' }) },
    { name: 'monto negativo', url: '/rail/transfers', payload: transfer({ amount: '-5.00' }) },
    { name: 'monto no numérico', url: '/rail/transfers', payload: transfer({ amount: 'abc' }) },
    { name: 'JSON mal formado', url: '/rail/transfers', payload: '{"reference":' },
    { name: 'reverso sin originalReference', url: '/rail/reversals', payload: { reference: 'R-1', amount: '1.00' } },
  ])('[RAIL-01] body inválido ($name) → 400 BAD_REQUEST sin tocar el riel', async ({ url, payload }) => {
    const app = startApp([]); // sin dados: si el riel llegara a decidir algo, el test fallaría
    const res = await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'BAD_REQUEST' });
  });

  it('[RAIL-02] reintento con la misma reference → misma respuesta; con otros datos → 409', async () => {
    const app = startApp([DICE.REJECT]);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/rail/transfers', payload });

    const first = await post(transfer());
    const retry = await post(transfer());
    expect(first.statusCode).toBe(422);
    expect(retry.statusCode).toBe(422);
    expect(retry.json()).toEqual(first.json());

    const conflict = await post(transfer({ amount: '1.00' }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'REFERENCE_CONFLICT' });
  });

  it.each([
    { coin: 'PROCESSED', draw: COIN.PROCESSED, lookupStatus: 200, postStatus: 200 },
    { coin: 'LOST', draw: COIN.LOST, lookupStatus: 404, postStatus: 503 },
  ])(
    '[RAIL-03] timeout $coin: mientras el POST sigue esperando, el GET ya dice la verdad ($lookupStatus)',
    async ({ draw, lookupStatus, postStatus }) => {
      const app = startApp([DICE.TIMEOUT, draw, LOOKUP.ANSWER], 300);
      let postFinished = false;
      const pendingPost = app
        .inject({ method: 'POST', url: '/rail/transfers', payload: transfer() })
        .finally(() => (postFinished = true));

      await sleep(50); // el POST ya se decidió y está esperando, como un cliente que se rindió a los 10 s
      const lookup = await app.inject({ method: 'GET', url: '/rail/transfers/T-1' });
      expect(postFinished).toBe(false);
      expect(lookup.statusCode).toBe(lookupStatus);

      expect((await pendingPost).statusCode).toBe(postStatus);
    },
  );

  it('[RAIL-04] POST /rail/reversals revierte una transferencia aceptada; el GET la muestra como REVERSAL', async () => {
    const app = startApp([DICE.ACCEPT, DICE.ACCEPT, LOOKUP.ANSWER]);
    await app.inject({ method: 'POST', url: '/rail/transfers', payload: transfer() });

    const res = await app.inject({
      method: 'POST',
      url: '/rail/reversals',
      payload: { reference: 'R-1', originalReference: 'T-1', amount: '50000.00' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reference: 'R-1', status: 'ACCEPTED' });

    const lookup = await app.inject({ method: 'GET', url: '/rail/transfers/R-1' });
    expect(lookup.json()).toEqual({ reference: 'R-1', kind: 'REVERSAL', status: 'ACCEPTED', amount: '50000.00' });
  });

  it('[RAIL-05] PUT /rail/admin/mode fuerza el resultado y GET /rail/admin/mode lo devuelve; modo inválido → 400', async () => {
    const app = startApp([]); // en modo forzado no se tira ningún dado
    const getMode = async () => (await app.inject({ method: 'GET', url: '/rail/admin/mode' })).json();
    expect(await getMode()).toEqual({ mode: 'RANDOM' });

    const put = await app.inject({ method: 'PUT', url: '/rail/admin/mode', payload: { mode: 'UNAVAILABLE' } });
    expect(put.json()).toEqual({ mode: 'UNAVAILABLE' });
    expect(await getMode()).toEqual({ mode: 'UNAVAILABLE' });
    const res = await app.inject({ method: 'POST', url: '/rail/transfers', payload: transfer() });
    expect(res.statusCode).toBe(503);

    const invalid = await app.inject({ method: 'PUT', url: '/rail/admin/mode', payload: { mode: 'CHAOS' } });
    expect(invalid.statusCode).toBe(400);
    expect(await getMode()).toEqual({ mode: 'UNAVAILABLE' });
  });

  it('[RAIL-05] tokens por HTTP: a EXT-OK-REVREJECT la transferencia se acepta y su reverso se rechaza', async () => {
    const app = startApp([]); // sin dados: lo deciden los tokens
    const sent = await app.inject({ method: 'POST', url: '/rail/transfers', payload: transfer({ to: 'EXT-OK-REVREJECT' }) });
    expect(sent.statusCode).toBe(200);

    const reversed = await app.inject({
      method: 'POST',
      url: '/rail/reversals',
      payload: { reference: 'R-1', originalReference: 'T-1', amount: '50000.00' },
    });
    expect(reversed.statusCode).toBe(422);
    expect(reversed.json()).toEqual({ reference: 'R-1', status: 'REJECTED', reason: 'REJECTED_BY_BANK' });
  });
});
