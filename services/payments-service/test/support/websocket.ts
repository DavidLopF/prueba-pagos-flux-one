import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

export interface TestSocket {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
  /** Espera hasta que llegue un mensaje que cumpla `predicate` (o falla tras `timeoutMs`). */
  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Abre un WebSocket contra la app (sin red) registrando los listeners ANTES de abrir: no se pierde el "ready". */
export async function connectWs(app: FastifyInstance, path: string): Promise<TestSocket> {
  const messages: Array<Record<string, unknown>> = [];
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => (resolveClosed = resolve));
  await app.ready();
  const ws = await app.injectWS(path, {}, {
    onInit: (socket) => {
      socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    },
  });
  return {
    ws,
    messages,
    closed,
    async waitFor(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`No llegó el mensaje esperado; recibidos: ${JSON.stringify(messages)}`);
    },
  };
}
