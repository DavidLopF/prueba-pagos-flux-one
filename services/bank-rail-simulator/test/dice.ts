/**
 * Azar controlado para los tests: el riel recibe exactamente estos valores, en orden.
 * Si tira un dado de más, lanza error: así los tests también prueban cuándo NO se tira el dado.
 */
export function draws(...values: number[]): () => number {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error('El riel tiró un dado que el test no esperaba');
    return value;
  };
}

/** Dado de un POST con los pesos por defecto: ACCEPT [0, .55) · REJECT [.55, .70) · UNAVAILABLE [.70, .85) · TIMEOUT [.85, 1). */
export const DICE = { ACCEPT: 0.1, REJECT: 0.6, UNAVAILABLE: 0.75, TIMEOUT: 0.9 } as const;

/** Moneda del timeout: ¿el banco alcanzó a procesarla? (< 0.5 = sí). */
export const COIN = { PROCESSED: 0.1, LOST: 0.9 } as const;

/** Dado de un GET en modo RANDOM con los pesos por defecto: UNAVAILABLE [0, .10) · TIMEOUT [.10, .15) · verdad [.15, 1). */
export const LOOKUP = { UNAVAILABLE: 0.05, TIMEOUT: 0.12, ANSWER: 0.5 } as const;
