import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Balance } from '../src/api/types';
import { PaymentLinks } from '../src/components/PaymentLinks';
import { PayLinkPage } from '../src/pages/PayLinkPage';
import {
  aPaymentLink,
  aPublicLink,
  aTransfer,
  callsTo,
  headersOf,
  jsonResponse,
  mockFetch,
  routeFetch,
  signIn,
} from './helpers';

const merchantAccounts: Balance[] = [{ accountId: 'ACC-001', balance: '1000000.00', currency: 'COP' }];
const payerAccounts: Balance[] = [{ accountId: 'ACC-002', balance: '500000.00', currency: 'COP' }];
const PAY = 'POST /api/payment-links/pl-1/pay';
const PUBLIC = 'GET /api/payment-links/pl-1/public';
const paidTransfer = aTransfer({
  id: 'trf-pl',
  type: 'INTERNAL',
  fromAccount: 'ACC-002',
  toAccount: 'ACC-001',
  amount: '25000.00',
  status: 'COMPLETED',
});

function TransferStub() {
  const { id } = useParams();
  return <p>Detalle {id}</p>;
}

function renderPayPage() {
  render(
    <MemoryRouter initialEntries={['/pay/pl-1']}>
      <Routes>
        <Route path="/pay/:id" element={<PayLinkPage />} />
        <Route path="/transfers/:id" element={<TransferStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Pagador con sesión (bob, ACC-002) frente al link ACTIVE de ACC-001; `pay` responde el POST de pago. */
async function openAsPayer(pay: () => Response | Promise<Response>) {
  const fetchMock = mockFetch();
  await signIn(fetchMock);
  routeFetch(fetchMock, {
    [PUBLIC]: () => jsonResponse(200, aPublicLink()),
    'GET /api/accounts': () => jsonResponse(200, payerAccounts),
    [PAY]: pay,
  });
  renderPayPage();
  await screen.findByRole('button', { name: 'Pagar' });
  return fetchMock;
}

describe('Links de pago', () => {
  it('[PL-01] crear un link muestra la URL para compartir', async () => {
    const fetchMock = mockFetch();
    let created = false;
    routeFetch(fetchMock, {
      'GET /api/payment-links?account=ACC-001': () => jsonResponse(200, created ? [aPaymentLink()] : []),
      'POST /api/payment-links': () => {
        created = true;
        return jsonResponse(201, aPaymentLink());
      },
    });
    render(
      <MemoryRouter>
        <PaymentLinks accounts={merchantAccounts} selected="ACC-001" />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Monto a cobrar (COP)'), { target: { value: '25000.00' } });
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Factura 123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear link' }));

    expect(await screen.findByDisplayValue(`${window.location.origin}/pay/pl-1`)).toBeTruthy();
    const [create] = callsTo(fetchMock, 'POST /api/payment-links');
    expect(JSON.parse(String(create?.body))).toEqual({
      accountId: 'ACC-001',
      amount: '25000.00', // string decimal, nunca number
      description: 'Factura 123',
    });
    const list = await screen.findByRole('list', { name: 'Links de cobro' }); // la lista se recarga
    expect(within(list).getByText('Factura 123')).toBeTruthy();
  });

  it('[PL-02] la página pública muestra el link sin autenticación', async () => {
    const fetchMock = mockFetch();
    routeFetch(fetchMock, { [PUBLIC]: () => jsonResponse(200, aPublicLink()) });
    renderPayPage(); // sin sesión

    expect(await screen.findByText('$ 25.000,00')).toBeTruthy();
    expect(screen.getByText('Factura 123')).toBeTruthy();
    expect(screen.getByText('ACC-001')).toBeTruthy();
    expect(screen.getByText('Activo')).toBeTruthy();
    expect(headersOf(callsTo(fetchMock, PUBLIC)[0]).Authorization).toBeUndefined();
    // Sin sesión no se paga: se ofrece iniciar sesión y volver a este mismo link.
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Inicia sesión para pagar' }).getAttribute('href')).toBe(
      '/login?next=%2Fpay%2Fpl-1',
    );
  });

  it('[PL-02] los datos públicos se piden sin token aunque haya sesión', async () => {
    const fetchMock = await openAsPayer(() => jsonResponse(201, paidTransfer));

    // Un token vencido nunca puede romper la vista pública: ese GET no lo lleva (las cuentas, sí).
    expect(headersOf(callsTo(fetchMock, PUBLIC)[0]).Authorization).toBeUndefined();
    expect(headersOf(callsTo(fetchMock, 'GET /api/accounts')[0]).Authorization).toBe('Bearer access-bob');
  });

  it('[PL-03] pagar llama POST /api/payment-links/{id}/pay una vez con Idempotency-Key y navega a la transferencia', async () => {
    const fetchMock = await openAsPayer(() => jsonResponse(201, paidTransfer));

    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));

    await screen.findByText('Detalle trf-pl');
    const pays = callsTo(fetchMock, PAY);
    expect(pays).toHaveLength(1);
    expect(headersOf(pays[0])['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headersOf(pays[0]).Authorization).toBe('Bearer access-bob');
    expect(JSON.parse(String(pays[0]?.body))).toEqual({ fromAccount: 'ACC-002' });
  });

  it('[PL-04] doble clic en Pagar envía una sola petición', async () => {
    const fetchMock = await openAsPayer(() => jsonResponse(201, paidTransfer));

    // Igual que en FE-01: ambos clics en el mismo act(), sin re-render entre ellos.
    const button = screen.getByRole('button', { name: 'Pagar' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await screen.findByText('Detalle trf-pl');
    expect(callsTo(fetchMock, PAY)).toHaveLength(1);
  });

  it('[PL-04] reintentar el pago tras un error de red reutiliza la misma Idempotency-Key', async () => {
    let attempts = 0;
    const fetchMock = await openAsPayer(() =>
      ++attempts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : jsonResponse(201, paidTransfer),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await screen.findByText(/se reutiliza la misma clave de idempotencia/);
    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await screen.findByText('Detalle trf-pl');

    const [first, second] = callsTo(fetchMock, PAY);
    expect(headersOf(first)['Idempotency-Key']).toBeTruthy();
    expect(headersOf(second)['Idempotency-Key']).toBe(headersOf(first)['Idempotency-Key']);
  });

  it('[PL-04] un link ya pagado se muestra como pagado y sin botón Pagar', async () => {
    const fetchMock = mockFetch();
    await signIn(fetchMock);
    routeFetch(fetchMock, {
      [PUBLIC]: () => jsonResponse(200, aPublicLink({ status: 'PAID' })),
      'GET /api/accounts': () => jsonResponse(200, payerAccounts),
    });
    renderPayPage();

    expect(await screen.findByText('Este link ya fue pagado.')).toBeTruthy();
    expect(screen.getByText('Pagado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
  });

  it('[PL-05] tras un rechazo definitivo (saldo insuficiente) el siguiente pago usa una Idempotency-Key nueva', async () => {
    let attempts = 0;
    const fetchMock = await openAsPayer(() =>
      ++attempts === 1
        ? jsonResponse(422, { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' })
        : jsonResponse(201, paidTransfer),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await screen.findByText('Saldo insuficiente para completar la operación.');
    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await screen.findByText('Detalle trf-pl');

    const [first, second] = callsTo(fetchMock, PAY);
    expect(headersOf(second)['Idempotency-Key']).not.toBe(headersOf(first)['Idempotency-Key']);
  });

  it('[PL-06] la lista muestra el estado de cada link y enlaza el pago de los pagados', async () => {
    const fetchMock = mockFetch();
    routeFetch(fetchMock, {
      'GET /api/payment-links?account=ACC-001': () =>
        jsonResponse(200, [
          aPaymentLink({ id: 'pl-3', description: 'Factura 125', status: 'ACTIVE' }),
          aPaymentLink({ id: 'pl-2', description: 'Factura 124', status: 'PAID', paidTransferId: 'trf-77' }),
          aPaymentLink({ id: 'pl-1', description: 'Factura 123', status: 'EXPIRED' }),
        ]),
    });
    render(
      <MemoryRouter>
        <PaymentLinks accounts={merchantAccounts} selected="ACC-001" />
      </MemoryRouter>,
    );

    const list = await screen.findByRole('list', { name: 'Links de cobro' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByTitle(/ACTIVE|PAID|EXPIRED/).textContent)).toEqual([
      'Activo',
      'Pagado',
      'Vencido',
    ]);
    expect(within(rows[1]!).getByRole('link', { name: 'Ver pago' }).getAttribute('href')).toBe('/transfers/trf-77');
  });
});
