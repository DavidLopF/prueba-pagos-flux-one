/**
 * Riel bancario simulado: lógica pura, sin HTTP (las rutas están en app.ts).
 *
 * - Decide qué hace el banco con cada operación nueva. Precedencia: token mágico > modo admin > azar.
 * - Guarda en memoria SOLO lo que el banco procesó, por `reference`. Eso lo hace idempotente
 *   (un reintento recibe lo guardado) y es la verdad que responde GET /rail/transfers/{reference}.
 * - El azar (`random`) se inyecta para que los tests sean deterministas.
 * - Dinero en centavos `bigint`, nunca `number` (CLAUDE.md §2).
 */

export const MODES = ['RANDOM', 'ACCEPT', 'REJECT', 'UNAVAILABLE', 'TIMEOUT'] as const;
/** Modo global (endpoint admin). RANDOM usa los pesos; los demás fuerzan el resultado de toda operación nueva. */
export type Mode = (typeof MODES)[number];

/** Qué hace el banco con una operación nueva. */
export type Outcome =
  | 'ACCEPT' // la procesa: transferencia aceptada (200); un reverso pasa antes por su validación (200/422)
  | 'REJECT' // la procesa y la rechaza (422)
  | 'UNAVAILABLE' // no la procesa (503)
  | 'TIMEOUT_PROCESSED' // igual que ACCEPT, pero responde tarde: el cliente ya se rindió
  | 'TIMEOUT_LOST'; // no la procesa y responde 503 tarde

export type Kind = 'TRANSFER' | 'REVERSAL';

export interface TransferRequest {
  reference: string;
  from: string;
  to: string;
  amount: string;
}

export interface ReversalRequest {
  reference: string;
  originalReference: string;
  amount: string;
}

/** Pesos relativos de cada resultado de un POST. Se normalizan: no tienen que sumar 1. */
export interface Weights {
  accept: number;
  reject: number;
  unavailable: number;
  timeout: number;
}

/** Probabilidad de que un GET falle; el resto de las veces responde la verdad. */
export interface LookupWeights {
  unavailable: number;
  timeout: number;
}

export const DEFAULT_WEIGHTS: Weights = { accept: 0.55, reject: 0.15, unavailable: 0.15, timeout: 0.15 };
export const DEFAULT_LOOKUP_WEIGHTS: LookupWeights = { unavailable: 0.1, timeout: 0.05 };

export interface RailOptions {
  weights?: Weights;
  lookupWeights?: LookupWeights;
  /** Fuente de azar en [0, 1). Por defecto Math.random; los tests inyectan valores fijos. */
  random?: () => number;
}

/** Lo que el banco decidió responder. app.ts solo lo envía (esperando antes si `delayed`). */
export interface RailReply {
  statusCode: number;
  body: object;
  /** Timeout simulado: la respuesta sale después de RAIL_TIMEOUT_DELAY_MS. */
  delayed: boolean;
  /** Qué pasó, para el log. */
  outcome: string;
}

/** Una operación que el banco procesó. */
interface Operation {
  reference: string;
  kind: Kind;
  amountCents: bigint;
  from?: string; // solo TRANSFER
  to?: string; // solo TRANSFER; aquí van los tokens mágicos, también los REV… de su reverso
  originalReference?: string; // solo REVERSAL
  status: 'ACCEPTED' | 'REJECTED';
  reason?: string; // solo REJECTED
}
type Incoming = Omit<Operation, 'status' | 'reason'>;
type Verdict = Pick<Operation, 'status' | 'reason'>;

const UNAVAILABLE_BODY = { error: 'UNAVAILABLE' };

/** Tokens mágicos para demos y e2e: palabra del `to` de la transferencia → resultado forzado. */
const TRANSFER_TOKENS = new Map<string, Outcome>([
  ['OK', 'ACCEPT'],
  ['REJECT', 'REJECT'],
  ['DOWN', 'UNAVAILABLE'],
  ['TIMEOUT', 'TIMEOUT_PROCESSED'],
  ['LOST', 'TIMEOUT_LOST'],
]);

/** Tokens del reverso: las mismas palabras con prefijo REV, escritas en el `to` de la transferencia original. */
const REVERSAL_TOKENS = new Map<string, Outcome>([
  ['REVOK', 'ACCEPT'],
  ['REVREJECT', 'REJECT'],
  ['REVDOWN', 'UNAVAILABLE'],
  ['REVTIMEOUT', 'TIMEOUT_PROCESSED'],
  ['REVLOST', 'TIMEOUT_LOST'],
]);

/**
 * Token mágico de `to`, si lo hay. Un token es una PALABRA COMPLETA, sin distinguir mayúsculas; las palabras
 * se separan por cualquier carácter no alfanumérico ("EXT-ok_1" → OK). Así "BROKER" no activa OK y
 * "REVREJECT" no activa REJECT. Si hay varios, gana el primero.
 */
export function findToken(to: string, kind: Kind): Outcome | undefined {
  const tokens = kind === 'TRANSFER' ? TRANSFER_TOKENS : REVERSAL_TOKENS;
  for (const word of to.toUpperCase().split(/[^A-Z0-9]+/)) {
    const outcome = tokens.get(word);
    if (outcome !== undefined) return outcome;
  }
  return undefined;
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Monto válido: decimal con máximo 2 decimales ("150000.50") y mayor que cero. */
export function isValidAmount(amount: string): boolean {
  return AMOUNT_PATTERN.test(amount) && toCents(amount) > 0n;
}

export class Rail {
  /** Modo global; lo cambia PUT /rail/admin/mode. */
  mode: Mode = 'RANDOM';
  /** Lo que el banco procesó, por reference. Si no está aquí, el banco nunca la recibió. */
  private readonly processed = new Map<string, Operation>();
  private readonly weights: Weights;
  private readonly lookupWeights: LookupWeights;
  private readonly random: () => number;

  constructor(options: RailOptions = {}) {
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.lookupWeights = options.lookupWeights ?? DEFAULT_LOOKUP_WEIGHTS;
    this.random = options.random ?? Math.random;
  }

  submitTransfer({ reference, from, to, amount }: TransferRequest): RailReply {
    const incoming: Incoming = { reference, kind: 'TRANSFER', from, to, amountCents: toCents(amount) };
    return this.submit(incoming, findToken(to, 'TRANSFER'), () => ({ status: 'ACCEPTED' }));
  }

  submitReversal({ reference, originalReference, amount }: ReversalRequest): RailReply {
    const incoming: Incoming = { reference, kind: 'REVERSAL', originalReference, amountCents: toCents(amount) };
    const original = this.processed.get(originalReference);
    // El token de un reverso (REVOK, REVREJECT, …) se busca en el `to` de la transferencia original.
    const token = original?.to === undefined ? undefined : findToken(original.to, 'REVERSAL');
    return this.submit(incoming, token, () => this.validateReversal(incoming, original));
  }

  /** GET /rail/transfers/{reference}; sirve también para la reference de un reverso. */
  lookup(reference: string): RailReply {
    const truth = this.truthAbout(reference);
    // En modos forzados la consulta es veraz e inmediata; en RANDOM también puede fallar.
    if (this.mode !== 'RANDOM') return truth;
    const { unavailable, timeout } = this.lookupWeights;
    const fate = pickWeighted(
      [
        ['UNAVAILABLE', unavailable],
        ['TIMEOUT', timeout],
        ['ANSWER', Math.max(0, 1 - unavailable - timeout)],
      ],
      this.random,
    );
    if (fate === 'UNAVAILABLE') return { statusCode: 503, body: UNAVAILABLE_BODY, delayed: false, outcome: fate };
    if (fate === 'TIMEOUT') return { ...truth, delayed: true, outcome: fate };
    return truth;
  }

  private submit(incoming: Incoming, token: Outcome | undefined, processNow: () => Verdict): RailReply {
    const stored = this.processed.get(incoming.reference);
    if (stored) {
      // Idempotencia por reference: no se procesa dos veces ni se vuelve a tirar el dado.
      if (!samePayload(stored, incoming)) {
        return { statusCode: 409, body: { error: 'REFERENCE_CONFLICT' }, delayed: false, outcome: 'CONFLICT' };
      }
      return { ...replyFor(stored), delayed: false, outcome: 'REPLAY' };
    }

    const outcome = token ?? this.decide();
    if (outcome === 'UNAVAILABLE' || outcome === 'TIMEOUT_LOST') {
      // No procesada: no se guarda nada, así que reenviar la misma reference es una operación nueva.
      return { statusCode: 503, body: UNAVAILABLE_BODY, delayed: outcome === 'TIMEOUT_LOST', outcome };
    }
    const verdict = outcome === 'REJECT' ? rejected('REJECTED_BY_BANK') : processNow();
    const operation: Operation = { ...incoming, ...verdict };
    // Se guarda ANTES de responder: mientras dura un timeout, un GET ya ve el resultado.
    this.processed.set(operation.reference, operation);
    return { ...replyFor(operation), delayed: outcome === 'TIMEOUT_PROCESSED', outcome };
  }

  /** Resultado de una operación nueva sin token: el que fuerza el modo, o al azar según los pesos. */
  private decide(): Outcome {
    const { accept, reject, unavailable, timeout } = this.weights;
    const choice =
      this.mode === 'RANDOM'
        ? pickWeighted(
            [
              ['ACCEPT', accept],
              ['REJECT', reject],
              ['UNAVAILABLE', unavailable],
              ['TIMEOUT', timeout],
            ],
            this.random,
          )
        : this.mode;
    if (choice !== 'TIMEOUT') return choice;
    // Timeout: 50/50 si el banco alcanzó a procesarla antes de que se perdiera la respuesta.
    return this.random() < 0.5 ? 'TIMEOUT_PROCESSED' : 'TIMEOUT_LOST';
  }

  /** Un reverso solo procede sobre una transferencia ACEPTADA, por el mismo monto y una sola vez. */
  private validateReversal(reversal: Incoming, original: Operation | undefined): Verdict {
    if (original?.kind !== 'TRANSFER' || original.status !== 'ACCEPTED') return rejected('ORIGINAL_NOT_FOUND');
    if (original.amountCents !== reversal.amountCents) return rejected('AMOUNT_MISMATCH');
    const alreadyReversed = [...this.processed.values()].some(
      (op) => op.kind === 'REVERSAL' && op.status === 'ACCEPTED' && op.originalReference === reversal.originalReference,
    );
    return alreadyReversed ? rejected('ALREADY_REVERSED') : { status: 'ACCEPTED' };
  }

  /** La verdad sobre una reference: lo guardado (200) o 404 si el banco nunca la procesó. */
  private truthAbout(reference: string): RailReply {
    const op = this.processed.get(reference);
    if (!op) return { statusCode: 404, body: { error: 'NOT_FOUND' }, delayed: false, outcome: 'NOT_FOUND' };
    const body = { reference, kind: op.kind, status: op.status, amount: formatCents(op.amountCents) };
    return { statusCode: 200, body, delayed: false, outcome: op.status };
  }
}

/** Elige una opción con probabilidad proporcional a su peso (los pesos se normalizan). */
function pickWeighted<T extends string>(options: Array<[T, number]>, random: () => number): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  const target = random() * total;
  let accumulated = 0;
  for (const [option, weight] of options) {
    accumulated += weight;
    if (target < accumulated) return option;
  }
  throw new Error('Pesos inválidos: deben ser >= 0 y sumar más que 0');
}

function rejected(reason: string): Verdict {
  return { status: 'REJECTED', reason };
}

/** ¿Mismos datos? El monto se compara en centavos: "10.5" y "10.50" son el mismo. */
function samePayload(a: Incoming, b: Incoming): boolean {
  return (
    a.kind === b.kind &&
    a.from === b.from &&
    a.to === b.to &&
    a.originalReference === b.originalReference &&
    a.amountCents === b.amountCents
  );
}

/** 200 ACCEPTED o 422 REJECTED, según lo que el banco decidió y guardó. */
function replyFor(op: Operation): Pick<RailReply, 'statusCode' | 'body'> {
  return op.status === 'ACCEPTED'
    ? { statusCode: 200, body: { reference: op.reference, status: 'ACCEPTED' } }
    : { statusCode: 422, body: { reference: op.reference, status: 'REJECTED', reason: op.reason } };
}

/** "150000.5" → 15000050n (el formato ya viene validado). */
function toCents(amount: string): bigint {
  const [units = '0', decimals = ''] = amount.split('.');
  return BigInt(units) * 100n + BigInt(decimals.padEnd(2, '0'));
}

/** 15000050n → "150000.50". */
function formatCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
