import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, TransferStatus } from '../src/api/types';
import { TransferDetailPage } from '../src/pages/TransferDetailPage';
import { aTransfer, jsonResponse, mockFetch } from './helpers';

function renderDetail(id: string) {
  render(
    <MemoryRouter initialEntries={[`/transfers/${id}`]}>
      <Routes>
        <Route path="/transfers/:id" element={<TransferDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Avanza el reloj falso y deja terminar las promesas (fetch → json → setState) dentro de act(). */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Con reloj real: deja terminar las respuestas pendientes (fetch → json → setState) dentro de act(). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const myAccounts = (accountId: string) => [{ accountId, balance: '1000000.00', currency: 'COP' }];

describe('Detalle de transferencia', () => {
  it('[FE-02] el detalle hace polling hasta un estado estable y se detiene', async () => {
    vi.useFakeTimers();
    // El banco tarda en confirmar: PENDING → UNKNOWN (timeout del riel) → COMPLETED (reconciliada).
    const statuses: TransferStatus[] = ['PENDING', 'UNKNOWN', 'COMPLETED'];
    let statusRequests = 0;
    let accountRequests = 0;
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/transfers/trf-1') {
        const status = statuses[Math.min(statusRequests++, statuses.length - 1)]!;
        return jsonResponse(200, aTransfer({ status }));
      }
      if (url === '/api/audit/transfers/trf-1/events') return jsonResponse(200, []);
      if (url === '/api/accounts') {
        accountRequests++;
        return jsonResponse(200, myAccounts('ACC-001')); // dueño de la cuenta origen
      }
      throw new Error(`URL inesperada: ${url}`);
    });

    renderDetail('trf-1');
    await advance(0); // la primera consulta sale de inmediato
    expect(statusRequests).toBe(1);
    expect(screen.getByText('Pendiente')).toBeTruthy();

    await advance(1500);
    expect(statusRequests).toBe(2);
    expect(screen.getByText('Por confirmar')).toBeTruthy();
    expect(screen.getByText(/Confirmando con el banco/)).toBeTruthy();

    await advance(1500);
    expect(statusRequests).toBe(3);
    expect(screen.getByText('Completada')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reversar' })).toBeTruthy();

    // Estado estable: por más tiempo que pase, no hay más consultas del estado.
    await advance(15_000);
    expect(statusRequests).toBe(3);
    expect(screen.queryByText(/Actualizando estado/)).toBeNull();
    expect(accountRequests).toBe(1); // mis cuentas: una sola vez al montar, no en cada consulta
  });

  it('[REV-01] el botón Reversar solo aparece para el dueño de la cuenta origen', async () => {
    const completed = aTransfer({ type: 'INTERNAL', fromAccount: 'ACC-001', toAccount: 'ACC-002', status: 'COMPLETED' });

    /** Abre el detalle con la sesión de quien posee `accountId` y dice si se ofrece "Reversar". */
    async function reverseOfferedTo(accountId: string): Promise<boolean> {
      const fetchMock = mockFetch();
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/transfers/trf-1') return jsonResponse(200, completed);
        if (url === '/api/audit/transfers/trf-1/events') return jsonResponse(200, []);
        if (url === '/api/accounts') return jsonResponse(200, myAccounts(accountId));
        throw new Error(`URL inesperada: ${url}`);
      });
      renderDetail('trf-1');
      await screen.findByText('Completada');
      await settle(); // también llegó la lista de mis cuentas
      const offered = screen.queryByRole('button', { name: 'Reversar' }) !== null;
      cleanup();
      return offered;
    }

    // El caso positivo usa la misma espera, así que el negativo no pasa solo porque "aún no cargó".
    expect(await reverseOfferedTo('ACC-001')).toBe(true); // quien envió (dueño del origen)
    expect(await reverseOfferedTo('ACC-002')).toBe(false); // quien recibió: el backend le daría 404
  });

  it('[FE-03] muestra la línea de tiempo de auditoría', async () => {
    const events: AuditEvent[] = [
      {
        eventId: 'evt-1',
        transferId: 'trf-1',
        eventType: 'TRANSFER_CREATED',
        status: 'PENDING',
        actorId: 'user-alice',
        occurredAt: '2026-10-15T13:00:00.000Z',
        payload: { amount: '150000.50' },
      },
      {
        eventId: 'evt-2',
        transferId: 'trf-1',
        eventType: 'TRANSFER_COMPLETED',
        status: 'COMPLETED',
        actorId: null,
        occurredAt: '2026-10-15T13:00:02.000Z',
        payload: {},
      },
    ];
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/transfers/trf-1') return jsonResponse(200, aTransfer({ status: 'COMPLETED' }));
      if (url === '/api/audit/transfers/trf-1/events') return jsonResponse(200, events);
      throw new Error(`URL inesperada: ${url}`);
    });

    renderDetail('trf-1');

    expect(await screen.findByText('$ 150.000,50')).toBeTruthy(); // monto con formato es-CO
    const timeline = await screen.findByRole('list', { name: 'Línea de tiempo de auditoría' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Transferencia creada');
    expect(items[1]!.textContent).toContain('Transferencia completada');
  });
});
