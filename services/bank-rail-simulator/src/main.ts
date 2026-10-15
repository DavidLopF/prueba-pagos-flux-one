import { DEFAULT_TIMEOUT_DELAY_MS, buildApp } from './app.js';
import { DEFAULT_LOOKUP_WEIGHTS, DEFAULT_WEIGHTS } from './rail.js';

/** Número >= 0 de una variable de entorno, o el valor por defecto si no está definida. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} debe ser un número >= 0 (llegó "${raw}")`);
  return value;
}

const weights = {
  accept: envNumber('RAIL_P_ACCEPT', DEFAULT_WEIGHTS.accept),
  reject: envNumber('RAIL_P_REJECT', DEFAULT_WEIGHTS.reject),
  unavailable: envNumber('RAIL_P_UNAVAILABLE', DEFAULT_WEIGHTS.unavailable),
  timeout: envNumber('RAIL_P_TIMEOUT', DEFAULT_WEIGHTS.timeout),
};
if (weights.accept + weights.reject + weights.unavailable + weights.timeout === 0) {
  throw new Error('Al menos uno de RAIL_P_ACCEPT/REJECT/UNAVAILABLE/TIMEOUT debe ser mayor que 0');
}
const lookupWeights = {
  unavailable: envNumber('RAIL_LOOKUP_P_UNAVAILABLE', DEFAULT_LOOKUP_WEIGHTS.unavailable),
  timeout: envNumber('RAIL_LOOKUP_P_TIMEOUT', DEFAULT_LOOKUP_WEIGHTS.timeout),
};
const timeoutDelayMs = envNumber('RAIL_TIMEOUT_DELAY_MS', DEFAULT_TIMEOUT_DELAY_MS);

const app = buildApp({ logger: true, weights, lookupWeights, timeoutDelayMs });

// Todo el estado vive en memoria: al apagar no hay nada que drenar.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

app.log.info({ weights, lookupWeights, timeoutDelayMs }, 'rail config');
await app.listen({ host: '0.0.0.0', port: envNumber('PORT', 8080) });
