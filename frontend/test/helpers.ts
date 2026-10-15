import { vi, type Mock } from 'vitest';
import { api } from '../src/api/client';
import type { PaymentLink, PublicPaymentLink, Transfer } from '../src/api/types';

/** Reemplaza el fetch global por un mock tipado (se restaura en test/setup.ts). */
export function mockFetch(): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Headers enviados en la llamada n a fetch (el cliente HTTP los arma como objeto plano). */
export function sentHeaders(fetchMock: Mock<typeof fetch>, n: number): Record<string, string> {
  return (fetchMock.mock.calls[n]?.[1]?.headers ?? {}) as Record<string, string>;
}

const routeKey = (input: RequestInfo | URL, init?: RequestInit) => `${init?.method ?? 'GET'} ${String(input)}`;

/** Responde cada "MÉTODO /url" con su handler; una petición no declarada falla (como error de red). */
export function routeFetch(
  fetchMock: Mock<typeof fetch>,
  routes: Record<string, () => Response | Promise<Response>>,
): void {
  fetchMock.mockImplementation(async (input, init) => {
    const handler = routes[routeKey(input, init)];
    if (!handler) throw new Error(`Petición no esperada en el test: ${routeKey(input, init)}`);
    return handler();
  });
}

/** RequestInit de cada llamada hecha a "MÉTODO /url". */
export function callsTo(fetchMock: Mock<typeof fetch>, key: string): RequestInit[] {
  return fetchMock.mock.calls.filter(([input, init]) => routeKey(input, init) === key).map(([, init]) => init ?? {});
}

export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

/** Deja una sesión iniciada pasando por el propio cliente (sin depender de las claves de sessionStorage). */
export async function signIn(fetchMock: Mock<typeof fetch>): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { accessToken: 'access-bob', refreshToken: 'refresh-bob', expiresIn: 900 }),
  );
  await api.login('bob@demo.co', 'secret');
  fetchMock.mockClear();
}

export function aPublicLink(overrides: Partial<PublicPaymentLink> = {}): PublicPaymentLink {
  return {
    id: 'pl-1',
    accountId: 'ACC-001',
    amount: '25000.00',
    currency: 'COP',
    description: 'Factura 123',
    status: 'ACTIVE',
    expiresAt: '2026-10-16T13:00:00.000Z',
    ...overrides,
  };
}

export function aPaymentLink(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return { ...aPublicLink(), paidTransferId: null, createdAt: '2026-10-15T13:00:00.000Z', ...overrides };
}

export function aTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'trf-1',
    type: 'EXTERNAL',
    fromAccount: 'ACC-001',
    toAccount: 'EXT-BANCO-123',
    amount: '150000.50',
    currency: 'COP',
    status: 'PENDING',
    attempts: 0,
    requiresManualReview: false,
    failureReason: null,
    createdAt: '2026-10-15T13:00:00.000Z',
    updatedAt: '2026-10-15T13:00:00.000Z',
    ...overrides,
  };
}
