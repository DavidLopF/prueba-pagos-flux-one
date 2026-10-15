import { describe, expect, it } from 'vitest';
import { Rail, findToken, isValidAmount, type ReversalRequest, type TransferRequest } from '../src/rail.js';
import { COIN, DICE, LOOKUP, draws } from './dice.js';

const transfer = (overrides: Partial<TransferRequest> = {}): TransferRequest => ({
  reference: 'T-1',
  from: 'ACC-001',
  to: 'EXT-BANCO-123',
  amount: '50000.00',
  ...overrides,
});

const reversal = (overrides: Partial<ReversalRequest> = {}): ReversalRequest => ({
  reference: 'R-1',
  originalReference: 'T-1',
  amount: '50000.00',
  ...overrides,
});

const TRUTH_T1 = { statusCode: 200, body: { reference: 'T-1', kind: 'TRANSFER', status: 'ACCEPTED', amount: '50000.00' } };

describe('Rail (lógica pura)', () => {
  it.each([
    { outcome: 'ACCEPT', draw: DICE.ACCEPT, statusCode: 200, body: { reference: 'T-1', status: 'ACCEPTED' } },
    {
      outcome: 'REJECT',
      draw: DICE.REJECT,
      statusCode: 422,
      body: { reference: 'T-1', status: 'REJECTED', reason: 'REJECTED_BY_BANK' },
    },
    { outcome: 'UNAVAILABLE', draw: DICE.UNAVAILABLE, statusCode: 503, body: { error: 'UNAVAILABLE' } },
  ])('[RAIL-01] dado $outcome → $statusCode inmediato', ({ outcome, draw, statusCode, body }) => {
    const rail = new Rail({ random: draws(draw) });
    expect(rail.submitTransfer(transfer())).toEqual({ statusCode, body, delayed: false, outcome });
  });

  it('[RAIL-01] dado TIMEOUT → la respuesta sale tarde (delayed)', () => {
    const rail = new Rail({ random: draws(DICE.TIMEOUT, COIN.PROCESSED) });
    expect(rail.submitTransfer(transfer())).toMatchObject({ statusCode: 200, delayed: true });
  });

  it('[RAIL-01] los pesos se normalizan: no tienen que sumar 1', () => {
    const rail = new Rail({ weights: { accept: 2, reject: 2, unavailable: 0, timeout: 0 }, random: draws(0.49, 0.51) });
    expect(rail.submitTransfer(transfer({ reference: 'T-1' })).outcome).toBe('ACCEPT');
    expect(rail.submitTransfer(transfer({ reference: 'T-2' })).outcome).toBe('REJECT');
  });

  it('[RAIL-01] un 503 no procesa nada: el GET da 404', () => {
    const rail = new Rail({ random: draws(DICE.UNAVAILABLE, LOOKUP.ANSWER) });
    rail.submitTransfer(transfer());
    expect(rail.lookup('T-1')).toMatchObject({ statusCode: 404, body: { error: 'NOT_FOUND' } });
  });

  it('[RAIL-01] en modo RANDOM el GET también puede dar 503 o timeout; si no, responde la verdad', () => {
    const rail = new Rail({ random: draws(DICE.ACCEPT, LOOKUP.UNAVAILABLE, LOOKUP.TIMEOUT, LOOKUP.ANSWER) });
    rail.submitTransfer(transfer());
    expect(rail.lookup('T-1')).toMatchObject({ statusCode: 503, body: { error: 'UNAVAILABLE' }, delayed: false });
    expect(rail.lookup('T-1')).toMatchObject({ ...TRUTH_T1, delayed: true });
    expect(rail.lookup('T-1')).toMatchObject({ ...TRUTH_T1, delayed: false });
  });

  it('[RAIL-01] monto válido: decimal mayor que cero con máximo 2 decimales', () => {
    for (const ok of ['1', '0.01', '150000.5', '150000.50']) expect(isValidAmount(ok)).toBe(true);
    for (const bad of ['0', '0.00', '-1', '1.234', '1.', '.5', '1e3', 'abc', '']) expect(isValidAmount(bad)).toBe(false);
  });

  it('[RAIL-02] la misma reference devuelve lo guardado sin reprocesar ni tirar otro dado', () => {
    const rail = new Rail({ random: draws(DICE.REJECT) }); // un solo dado: el reintento no puede tirar otro
    const first = rail.submitTransfer(transfer());
    const retry = rail.submitTransfer(transfer({ amount: '50000' })); // mismo monto, escrito distinto
    expect(first.statusCode).toBe(422);
    expect(retry).toEqual({ ...first, outcome: 'REPLAY' });
  });

  it('[RAIL-02] la misma reference con otros datos → 409 REFERENCE_CONFLICT', () => {
    const rail = new Rail({ random: draws(DICE.ACCEPT) });
    rail.submitTransfer(transfer());
    const conflict = { statusCode: 409, body: { error: 'REFERENCE_CONFLICT' } };
    expect(rail.submitTransfer(transfer({ amount: '1.00' }))).toMatchObject(conflict);
    expect(rail.submitTransfer(transfer({ from: 'ACC-002' }))).toMatchObject(conflict);
    expect(rail.submitTransfer(transfer({ to: 'EXT-OTRO' }))).toMatchObject(conflict);
    expect(rail.submitReversal(reversal({ reference: 'T-1' }))).toMatchObject(conflict); // otra clase de operación
  });

  it('[RAIL-02] una operación no procesada (503) no ocupa la reference: el reintento sí se procesa', () => {
    const rail = new Rail({ random: draws(DICE.UNAVAILABLE, DICE.ACCEPT) });
    expect(rail.submitTransfer(transfer()).statusCode).toBe(503);
    expect(rail.submitTransfer(transfer()).statusCode).toBe(200);
  });

  it('[RAIL-03] timeout procesado: se guarda antes de responder y el GET devuelve 200 con el estado', () => {
    const rail = new Rail({ random: draws(DICE.TIMEOUT, COIN.PROCESSED, LOOKUP.ANSWER) });
    expect(rail.submitTransfer(transfer())).toEqual({
      statusCode: 200,
      body: { reference: 'T-1', status: 'ACCEPTED' },
      delayed: true,
      outcome: 'TIMEOUT_PROCESSED',
    });
    expect(rail.lookup('T-1')).toMatchObject(TRUTH_T1);
  });

  it('[RAIL-03] timeout perdido: nada se guarda; el GET da 404 y reenviar la misma reference la procesa', () => {
    const rail = new Rail({ random: draws(DICE.TIMEOUT, COIN.LOST, LOOKUP.ANSWER, DICE.ACCEPT) });
    expect(rail.submitTransfer(transfer())).toEqual({
      statusCode: 503,
      body: { error: 'UNAVAILABLE' },
      delayed: true,
      outcome: 'TIMEOUT_LOST',
    });
    expect(rail.lookup('T-1')).toMatchObject({ statusCode: 404, body: { error: 'NOT_FOUND' } });
    expect(rail.submitTransfer(transfer()).statusCode).toBe(200);
  });

  it('[RAIL-04] reverso de una transferencia aceptada por el mismo monto → 200; el GET lo muestra como REVERSAL', () => {
    const rail = new Rail({ random: draws(DICE.ACCEPT, DICE.ACCEPT, LOOKUP.ANSWER) });
    rail.submitTransfer(transfer());
    expect(rail.submitReversal(reversal())).toMatchObject({ statusCode: 200, body: { reference: 'R-1', status: 'ACCEPTED' } });
    expect(rail.lookup('R-1').body).toEqual({ reference: 'R-1', kind: 'REVERSAL', status: 'ACCEPTED', amount: '50000.00' });
  });

  it('[RAIL-04] 422 si la original no existe, no fue aceptada o el monto no coincide', () => {
    const rail = new Rail({ random: draws(DICE.REJECT, DICE.ACCEPT, DICE.ACCEPT, DICE.ACCEPT, DICE.ACCEPT) });
    rail.submitTransfer(transfer({ reference: 'T-REJECTED' }));
    rail.submitTransfer(transfer({ reference: 'T-1' }));
    expect(rail.submitReversal(reversal({ reference: 'R-1', originalReference: 'NO-EXISTE' }))).toEqual({
      statusCode: 422,
      body: { reference: 'R-1', status: 'REJECTED', reason: 'ORIGINAL_NOT_FOUND' },
      delayed: false,
      outcome: 'ACCEPT', // el dado dijo "procesar"; la validación la rechazó
    });
    expect(rail.submitReversal(reversal({ reference: 'R-2', originalReference: 'T-REJECTED' })).body).toMatchObject({
      reason: 'ORIGINAL_NOT_FOUND',
    });
    expect(rail.submitReversal(reversal({ reference: 'R-3', amount: '49999.99' })).body).toMatchObject({
      reason: 'AMOUNT_MISMATCH',
    });
  });

  it('[RAIL-04] una transferencia se reversa una sola vez; repetir el mismo reverso no es un segundo reverso', () => {
    const rail = new Rail({ random: draws(DICE.ACCEPT, DICE.ACCEPT, DICE.ACCEPT) });
    rail.submitTransfer(transfer());
    expect(rail.submitReversal(reversal()).statusCode).toBe(200);
    expect(rail.submitReversal(reversal())).toMatchObject({ statusCode: 200, outcome: 'REPLAY' });
    expect(rail.submitReversal(reversal({ reference: 'R-2' })).body).toEqual({
      reference: 'R-2',
      status: 'REJECTED',
      reason: 'ALREADY_REVERSED',
    });
  });

  it('[RAIL-04] el dado también aplica a reversos: REJECT → 422 aunque el reverso sea válido', () => {
    const rail = new Rail({ random: draws(DICE.ACCEPT, DICE.REJECT) });
    rail.submitTransfer(transfer());
    expect(rail.submitReversal(reversal()).body).toEqual({ reference: 'R-1', status: 'REJECTED', reason: 'REJECTED_BY_BANK' });
  });

  it('[RAIL-05] tokens mágicos: palabra completa del `to`, sin distinguir mayúsculas', () => {
    expect(findToken('EXT-OK-1', 'TRANSFER')).toBe('ACCEPT');
    expect(findToken('ext-reject', 'TRANSFER')).toBe('REJECT');
    expect(findToken('EXT_DOWN', 'TRANSFER')).toBe('UNAVAILABLE');
    expect(findToken('EXT TIMEOUT', 'TRANSFER')).toBe('TIMEOUT_PROCESSED');
    expect(findToken('EXT-LOST-7', 'TRANSFER')).toBe('TIMEOUT_LOST');
    expect(findToken('EXT-BROKER-9', 'TRANSFER')).toBeUndefined(); // "OK" dentro de otra palabra no cuenta
    expect(findToken('EXT-BANCO-123', 'TRANSFER')).toBeUndefined();
  });

  it('[RAIL-05] los tokens REV… son solo del reverso y no activan los de la transferencia (ni al revés)', () => {
    expect(findToken('EXT-REVREJECT', 'TRANSFER')).toBeUndefined();
    expect(findToken('EXT-OK-REVREJECT', 'TRANSFER')).toBe('ACCEPT');
    expect(findToken('EXT-OK-REVREJECT', 'REVERSAL')).toBe('REJECT');
    expect(findToken('EXT-REJECT', 'REVERSAL')).toBeUndefined();
    expect(findToken('ext-revdown', 'REVERSAL')).toBe('UNAVAILABLE');
  });

  it('[RAIL-05] un token fuerza el resultado sin tirar el dado y gana sobre el modo admin', () => {
    const rail = new Rail({ random: draws() }); // ningún dado: todo lo deciden los tokens
    rail.mode = 'UNAVAILABLE';
    expect(rail.submitTransfer(transfer({ reference: 'T-1', to: 'EXT-OK-REVDOWN' }))).toMatchObject({ statusCode: 200 });
    expect(rail.submitReversal(reversal({ originalReference: 'T-1' }))).toMatchObject({ statusCode: 503, delayed: false });
    expect(rail.submitTransfer(transfer({ reference: 'T-2', to: 'EXT-REJECT' }))).toMatchObject({ statusCode: 422 });
    expect(rail.submitTransfer(transfer({ reference: 'T-3', to: 'EXT-DOWN' }))).toMatchObject({ statusCode: 503, delayed: false });
    expect(rail.submitTransfer(transfer({ reference: 'T-4', to: 'EXT-TIMEOUT' }))).toMatchObject({ statusCode: 200, delayed: true });
    expect(rail.submitTransfer(transfer({ reference: 'T-5', to: 'EXT-LOST' }))).toMatchObject({ statusCode: 503, delayed: true });
  });

  it('[RAIL-05] el modo admin fuerza el resultado de toda operación nueva hasta volver a RANDOM', () => {
    const rail = new Rail({ random: draws(COIN.LOST, DICE.ACCEPT) });
    rail.mode = 'REJECT';
    expect(rail.submitTransfer(transfer({ reference: 'T-1' })).statusCode).toBe(422);
    rail.mode = 'UNAVAILABLE';
    expect(rail.submitTransfer(transfer({ reference: 'T-2' })).statusCode).toBe(503);
    rail.mode = 'ACCEPT';
    expect(rail.submitTransfer(transfer({ reference: 'T-3' })).statusCode).toBe(200);
    expect(rail.submitReversal(reversal({ originalReference: 'T-3' })).statusCode).toBe(200);
    rail.mode = 'TIMEOUT'; // fuerza el timeout; la moneda (¿la procesó?) sigue al azar
    expect(rail.submitTransfer(transfer({ reference: 'T-4' }))).toMatchObject({ statusCode: 503, delayed: true });
    rail.mode = 'RANDOM';
    expect(rail.submitTransfer(transfer({ reference: 'T-5' })).statusCode).toBe(200);
  });

  it('[RAIL-05] en modo forzado los GET son veraces e inmediatos (sin dado)', () => {
    const rail = new Rail({ random: draws() });
    rail.mode = 'ACCEPT';
    rail.submitTransfer(transfer());
    expect(rail.lookup('T-1')).toMatchObject({ ...TRUTH_T1, delayed: false });
    expect(rail.lookup('NO-EXISTE')).toMatchObject({ statusCode: 404, delayed: false });
  });
});
