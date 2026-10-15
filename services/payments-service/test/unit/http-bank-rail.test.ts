import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/model/Money.js';
import { HttpBankRail } from '../../src/infrastructure/rail/HttpBankRail.js';

/** Servidor HTTP mínimo: la reference decide la respuesta del "banco". */
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const reference = decodeURIComponent(request.url?.split('/').pop() ?? '');
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const ref = request.method === 'POST' ? (JSON.parse(body) as { reference: string }).reference : reference;
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (ref === 'slow') return setTimeout(() => reply(200, { status: 'ACCEPTED' }), 500);
      if (ref === 'ok') return reply(200, { reference: ref, status: 'ACCEPTED' });
      if (ref === 'rejected') return reply(request.method === 'GET' ? 200 : 422, { reference: ref, status: 'REJECTED' });
      if (ref === 'down') return reply(503, { error: 'UNAVAILABLE' });
      if (ref === 'weird') return reply(500, {});
      return reply(404, { error: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Puerto que acaba de liberarse: conectar ahí da ECONNREFUSED. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const send = (rail: HttpBankRail, reference: string) =>
  rail.sendTransfer({ reference, from: 'ACC-001', to: 'EXT-1', amount: Money.fromString('10.00') });

describe('HttpBankRail: traducción de las respuestas del riel', () => {
  it('[EXT-02] 200 → ACCEPTED', async () => {
    expect(await send(new HttpBankRail(baseUrl), 'ok')).toBe('ACCEPTED');
  });

  it('[EXT-03] 422 → REJECTED', async () => {
    expect(await send(new HttpBankRail(baseUrl), 'rejected')).toBe('REJECTED');
  });

  it('[EXT-04] 503 o conexión rechazada → UNAVAILABLE (no se procesó)', async () => {
    expect(await send(new HttpBankRail(baseUrl), 'down')).toBe('UNAVAILABLE');
    expect(await send(new HttpBankRail(`http://127.0.0.1:${await closedPort()}`), 'ok')).toBe('UNAVAILABLE');
  });

  it('[EXT-05] sin respuesta dentro del timeout o una respuesta inesperada → UNKNOWN', async () => {
    expect(await send(new HttpBankRail(baseUrl, 100), 'slow')).toBe('UNKNOWN');
    expect(await send(new HttpBankRail(baseUrl), 'weird')).toBe('UNKNOWN');
  });

  it('[EXT-06] el GET traduce 200 con estado, 404 y 503', async () => {
    const rail = new HttpBankRail(baseUrl);

    expect(await rail.lookup('ok')).toBe('ACCEPTED');
    expect(await rail.lookup('rejected')).toBe('REJECTED');
    expect(await rail.lookup('nunca-llego')).toBe('NOT_FOUND');
    expect(await rail.lookup('down')).toBe('UNAVAILABLE');
    expect(await new HttpBankRail(baseUrl, 100).lookup('slow')).toBe('UNKNOWN');
  });
});
