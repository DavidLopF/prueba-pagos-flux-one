import type { Money } from '../../domain/model/Money.js';
import type { BankRail, RailLookupResult, RailSendResult } from '../../domain/ports/BankRail.js';

type RailHttpResponse =
  | { kind: 'response'; status: number; body: unknown }
  /** No hubo respuesta a tiempo o la conexión se cortó a mitad: el banco pudo procesarla o no. */
  | { kind: 'no-response' }
  /** No se pudo ni conectar (ECONNREFUSED, DNS): la operación seguro NO llegó al banco. */
  | { kind: 'unreachable' };

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Adaptador HTTP del riel bancario (docs/spec.md "Respuestas del riel"). */
export class HttpBankRail implements BankRail {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async sendTransfer(request: { reference: string; from: string; to: string; amount: Money }): Promise<RailSendResult> {
    const response = await this.call('POST', '/rail/transfers', {
      reference: request.reference,
      from: request.from,
      to: request.to,
      amount: request.amount.toString(),
    });
    return toSendResult(response);
  }

  async sendReversal(request: { reference: string; originalReference: string; amount: Money }): Promise<RailSendResult> {
    const response = await this.call('POST', '/rail/reversals', {
      reference: request.reference,
      originalReference: request.originalReference,
      amount: request.amount.toString(),
    });
    return toSendResult(response);
  }

  async lookup(reference: string): Promise<RailLookupResult> {
    const response = await this.call('GET', `/rail/transfers/${encodeURIComponent(reference)}`);
    if (response.kind === 'unreachable') return 'UNAVAILABLE';
    if (response.kind === 'no-response') return 'UNKNOWN';
    if (response.status === 404) return 'NOT_FOUND';
    if (response.status === 503) return 'UNAVAILABLE';
    if (response.status === 200) {
      const status = (response.body as { status?: unknown } | null)?.status;
      if (status === 'ACCEPTED' || status === 'REJECTED') return status;
    }
    return 'UNKNOWN';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RailHttpResponse> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // El timeout cubre también la lectura del cuerpo.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      return { kind: 'response', status: response.status, body: parseJson(text) };
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      return code && UNREACHABLE_CODES.has(code) ? { kind: 'unreachable' } : { kind: 'no-response' };
    }
  }
}

/** 200 → ACCEPTED, 422 → REJECTED, 503/sin conexión → UNAVAILABLE; cualquier otra cosa es desconocida. */
function toSendResult(response: RailHttpResponse): RailSendResult {
  if (response.kind === 'unreachable') return 'UNAVAILABLE';
  if (response.kind === 'no-response') return 'UNKNOWN';
  switch (response.status) {
    case 200:
      return 'ACCEPTED';
    case 422:
      return 'REJECTED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
