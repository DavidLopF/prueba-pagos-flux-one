import type { Money } from '../model/Money.js';

/**
 * Resultado de enviar una operación al riel:
 * - ACCEPTED (200) / REJECTED (422): respuesta definitiva del banco.
 * - UNAVAILABLE (503 o conexión rechazada): el banco NO la procesó.
 * - UNKNOWN (sin respuesta en 10 s u otra respuesta inesperada): pudo procesarse o no.
 */
export type RailSendResult = 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE' | 'UNKNOWN';

/** Resultado de consultar una reference en el banco. NOT_FOUND = el banco nunca la procesó. */
export type RailLookupResult = 'ACCEPTED' | 'REJECTED' | 'NOT_FOUND' | 'UNAVAILABLE' | 'UNKNOWN';

export interface BankRail {
  sendTransfer(request: { reference: string; from: string; to: string; amount: Money }): Promise<RailSendResult>;
  sendReversal(request: { reference: string; originalReference: string; amount: Money }): Promise<RailSendResult>;
  lookup(reference: string): Promise<RailLookupResult>;
}
