import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Balance } from '../src/api/types';
import { TransferForm } from '../src/components/TransferForm';
import { aTransfer, jsonResponse, mockFetch, sentHeaders } from './helpers';

const accounts: Balance[] = [{ accountId: 'ACC-001', balance: '1000000.00', currency: 'COP' }];
const created = aTransfer({ type: 'INTERNAL', toAccount: 'ACC-002', status: 'COMPLETED' });

function renderForm() {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<TransferForm accounts={accounts} />} />
        <Route path="/transfers/:id" element={<p>Detalle de la transferencia</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillForm(amount = '150000.50') {
  fireEvent.change(screen.getByLabelText('Cuenta destino'), { target: { value: 'ACC-002' } });
  fireEvent.change(screen.getByLabelText('Monto (COP)'), { target: { value: amount } });
}

const sendButton = () => screen.getByRole('button', { name: 'Enviar' });

describe('Formulario de nueva transferencia', () => {
  it('[FE-01] doble clic en Enviar hace una sola petición', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(201, created));
    renderForm();
    fillForm();

    // Los dos clics van en el mismo act(): React no re-renderiza entre ellos, así que para el segundo clic
    // el botón sigue habilitado en el DOM (como en un doble clic real). Solo la guarda con useRef lo frena.
    const button = sendButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await screen.findByText('Detalle de la transferencia'); // tras crearla navega al detalle
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/transfers');
    expect(init?.method).toBe('POST');
    expect(sentHeaders(fetchMock, 0)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    // El monto viaja como string decimal, nunca como number.
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'INTERNAL',
      fromAccount: 'ACC-001',
      toAccount: 'ACC-002',
      amount: '150000.50',
    });
  });

  it('[FE-01] reintento tras error de red reutiliza la misma Idempotency-Key', async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // la red cae: no sabemos si el servidor la procesó
      .mockResolvedValueOnce(jsonResponse(201, created));
    renderForm();
    fillForm();

    fireEvent.click(sendButton());
    await screen.findByText(/se reutiliza la misma clave de idempotencia/);

    fireEvent.click(sendButton()); // el usuario reintenta
    await screen.findByText('Detalle de la transferencia');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstKey = sentHeaders(fetchMock, 0)['Idempotency-Key'];
    expect(firstKey).toBeTruthy();
    expect(sentHeaders(fetchMock, 1)['Idempotency-Key']).toBe(firstKey);
  });

  it('[FE-01] tras un rechazo definitivo (4xx), editar el formulario genera una Idempotency-Key nueva', async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(422, { code: 'INSUFFICIENT_FUNDS', message: 'Saldo insuficiente' }))
      .mockResolvedValueOnce(jsonResponse(201, created));
    renderForm();
    fillForm('2000000');

    fireEvent.click(sendButton());
    await screen.findByText('Saldo insuficiente para completar la operación.');

    // Otro payload con la misma key sería 422 IDEMPOTENCY_KEY_REUSED: al editar se genera una nueva.
    fireEvent.change(screen.getByLabelText('Monto (COP)'), { target: { value: '1000' } });
    fireEvent.click(sendButton());
    await screen.findByText('Detalle de la transferencia');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentHeaders(fetchMock, 1)['Idempotency-Key']).not.toBe(sentHeaders(fetchMock, 0)['Idempotency-Key']);
  });
});
