import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { onSessionExpired } from '../src/api/client';
import type { Transfer } from '../src/api/types';
import { DashboardPage } from '../src/pages/DashboardPage';
import { aTransfer, callsTo, jsonResponse, mockFetch, routeFetch, signIn } from './helpers';

/** WebSocket falso: guarda cada conexión que abre el hook para que el test haga de servidor. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  serverSends(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }

  serverCloses(code: number) {
    act(() => this.onclose?.({ code }));
  }
}

const socket = (n: number) => FakeWebSocket.instances[n]!;
const socketUrl = (token: string) => `ws://${window.location.host}/api/ws?token=${token}`;

/** Avanza el reloj falso y deja terminar las promesas (fetch → json → setState) dentro de act(). */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Dashboard abierto con sesión (tokens access-bob / refresh-bob) frente a un "servidor" con datos mutables. */
async function openDashboard() {
  const server = { balance: '1000000.00', transfers: [] as Transfer[], refreshOk: true };
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const fetchMock = mockFetch();
  await signIn(fetchMock);
  routeFetch(fetchMock, {
    'GET /api/accounts': () =>
      jsonResponse(200, [{ accountId: 'ACC-001', balance: server.balance, currency: 'COP' }]),
    'GET /api/transfers?account=ACC-001': () => jsonResponse(200, server.transfers),
    'GET /api/payment-links?account=ACC-001': () => jsonResponse(200, []),
    'POST /api/auth/refresh': () =>
      server.refreshOk
        ? jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 })
        : jsonResponse(401, { code: 'UNAUTHORIZED', message: 'refresh token revocado' }),
  });
  vi.useFakeTimers();
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  await advance(0); // carga inicial
  const requests = () => ({
    accounts: callsTo(fetchMock, 'GET /api/accounts').length,
    transfers: callsTo(fetchMock, 'GET /api/transfers?account=ACC-001').length,
    links: callsTo(fetchMock, 'GET /api/payment-links?account=ACC-001').length,
  });
  return { server, fetchMock, requests };
}

describe('Movimientos en tiempo real', () => {
  it('[FE-04] un aviso transfer.updated vuelve a consultar movimientos y saldos (3 avisos seguidos = 1 recarga)', async () => {
    const { server, requests } = await openDashboard();
    expect(socket(0).url).toBe(socketUrl('access-bob'));
    socket(0).serverSends({ type: 'ready' });
    await advance(300); // al conectar se pone al día una vez
    expect(screen.getByText('En vivo')).toBeTruthy();
    const before = requests();

    // Se mueve dinero en otra sesión: cambian los datos y llega una ráfaga de 3 avisos.
    server.balance = '900000.00';
    server.transfers = [aTransfer({ id: 'trf-new', type: 'INTERNAL', toAccount: 'ACC-002', status: 'COMPLETED' })];
    for (const eventType of ['TRANSFER_CREATED', 'TRANSFER_COMPLETED', 'TRANSFER_COMPLETED']) {
      socket(0).serverSends({
        type: 'transfer.updated',
        transferId: 'trf-new',
        eventType,
        status: 'COMPLETED',
        occurredAt: '2026-10-15T14:00:00.000Z',
      });
    }

    await advance(299);
    expect(requests()).toEqual(before); // debounce: todavía no
    await advance(1);
    expect(requests()).toEqual({
      accounts: before.accounts + 1,
      transfers: before.transfers + 1,
      links: before.links + 1,
    });
    expect(screen.getByText('$ 900.000,00')).toBeTruthy(); // saldo nuevo, sin pulsar "Actualizar"
    expect(screen.getByText('Enviada a ACC-002')).toBeTruthy(); // movimiento nuevo
  });

  it('[FE-04] si la conexión se cae reconecta con backoff y vuelve a consultar al recibir ready', async () => {
    const { requests } = await openDashboard();
    socket(0).serverSends({ type: 'ready' });
    await advance(300);

    socket(0).serverCloses(1006); // se cae la red
    expect(screen.getByText('Reconectando…')).toBeTruthy();
    await advance(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(2); // 1 s
    socket(1).serverCloses(1006); // sigue sin red
    await advance(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(3); // 2 s

    const before = requests();
    socket(2).serverSends({ type: 'ready' }); // vuelve la conexión
    await advance(300);
    expect(screen.getByText('En vivo')).toBeTruthy();
    expect(requests().accounts).toBe(before.accounts + 1); // se pone al día con lo que pasó sin conexión
    expect(requests().transfers).toBe(before.transfers + 1);

    socket(2).serverCloses(1006); // tras un "ready" el backoff vuelve a empezar en 1 s
    await advance(1000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('[RT-02] un cierre 4401 renueva el token y reconecta con el token nuevo', async () => {
    const { fetchMock } = await openDashboard();

    socket(0).serverCloses(4401); // token vencido
    await advance(0); // refresh + reconexión inmediata (sin backoff)

    const refreshes = callsTo(fetchMock, 'POST /api/auth/refresh');
    expect(refreshes).toHaveLength(1);
    expect(JSON.parse(String(refreshes[0]?.body))).toEqual({ refreshToken: 'refresh-bob' });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket(1).url).toBe(socketUrl('access-2'));
  });

  it('[RT-02] si el refresh falla tras un 4401 se cierra la sesión y no se reconecta', async () => {
    const sessionExpired = vi.fn();
    const unsubscribe = onSessionExpired(sessionExpired);
    try {
      const { server } = await openDashboard();
      server.refreshOk = false;

      socket(0).serverCloses(4401);
      await advance(60_000);

      expect(sessionExpired).toHaveBeenCalledTimes(1); // la app navega al login, igual que ante un HTTP 401
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
