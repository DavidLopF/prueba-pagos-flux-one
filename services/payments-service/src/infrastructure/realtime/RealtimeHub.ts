import type { WebSocket } from 'ws';

/** Aviso que recibe el navegador (docs/spec.md §12). Solo dice qué cambió; el cliente consulta la API. */
export interface TransferUpdate {
  type: 'transfer.updated';
  transferId: string;
  eventType: string;
  status: string;
  occurredAt: string;
}

/**
 * Registro en memoria de los WebSocket abiertos en ESTA instancia, por usuario (RT-01).
 * Con varias instancias cada una tiene su hub y recibe todos los eventos por su propia cola (RT-03).
 */
export class RealtimeHub {
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  private heartbeat: NodeJS.Timeout | null = null;

  add(userId: string, socket: WebSocket): void {
    const sockets = this.socketsByUser.get(userId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.socketsByUser.set(userId, sockets);
    socket.once('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.socketsByUser.delete(userId);
    });
  }

  /** Envía el aviso solo a los participantes conectados a esta instancia. Devuelve cuántos sockets lo recibieron. */
  notify(participantIds: string[], update: TransferUpdate): number {
    const payload = JSON.stringify(update);
    let delivered = 0;
    for (const userId of new Set(participantIds)) {
      for (const socket of this.socketsByUser.get(userId) ?? []) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
          delivered++;
        }
      }
    }
    return delivered;
  }

  /** Ping periódico: mantiene viva la conexión a través de proxies (nginx) que cortan conexiones inactivas. */
  startHeartbeat(intervalMs = 25_000): void {
    this.heartbeat = setInterval(() => {
      for (const sockets of this.socketsByUser.values()) {
        for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.ping();
      }
    }, intervalMs);
    this.heartbeat.unref();
  }

  closeAll(code: number, reason: string): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const sockets of this.socketsByUser.values()) {
      for (const socket of sockets) socket.close(code, reason);
    }
  }
}
