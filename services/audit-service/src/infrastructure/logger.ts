/** Minimal structured logger (pino-compatible, so Fastify's `app.log` satisfies it). */
export interface Logger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}
