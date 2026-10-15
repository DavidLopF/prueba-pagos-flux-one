import amqp, { type ChannelModel } from 'amqplib';
import type { RealtimeHub } from './RealtimeHub.js';

const RECONNECT_DELAY_MS = 2_000;

/**
 * Lleva los eventos de transferencias (los mismos del outbox) a los WebSocket de esta instancia (RT-01, RT-03).
 * Usa una cola EXCLUSIVA, autodelete y con nombre generado por el broker: cada instancia recibe una copia de
 * todos los eventos (fan-out) y la cola desaparece cuando la instancia se va. noAck: los avisos son best-effort;
 * la fuente de verdad sigue siendo la API, y el cliente vuelve a consultar al reconectar.
 */
export class RabbitMqRealtimeConsumer {
  private connection: ChannelModel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly exchange: string,
    private readonly hub: RealtimeHub,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.connection?.close().catch(() => undefined);
  }

  /** Traduce el evento del outbox a un aviso para los participantes. Ignora mensajes que no entiende. */
  handle(content: Buffer): number {
    try {
      const event = JSON.parse(content.toString('utf8')) as {
        aggregateId?: unknown;
        eventType?: unknown;
        occurredAt?: unknown;
        participantIds?: unknown;
        payload?: { status?: unknown };
      };
      if (
        typeof event.aggregateId !== 'string' ||
        typeof event.eventType !== 'string' ||
        typeof event.occurredAt !== 'string' ||
        !Array.isArray(event.participantIds)
      ) {
        return 0;
      }
      return this.hub.notify(event.participantIds.filter((id): id is string => typeof id === 'string'), {
        type: 'transfer.updated',
        transferId: event.aggregateId,
        eventType: event.eventType,
        status: typeof event.payload?.status === 'string' ? event.payload.status : 'UNKNOWN',
        occurredAt: event.occurredAt,
      });
    } catch {
      return 0;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const connection = await amqp.connect(this.url);
      connection.on('error', (error: Error) => this.log(`RabbitMQ (tiempo real) error: ${error.message}`));
      connection.on('close', () => this.scheduleReconnect());
      const channel = await connection.createChannel();
      channel.on('error', (error: Error) => this.log(`RabbitMQ (tiempo real) channel error: ${error.message}`));
      channel.on('close', () => void connection.close().catch(() => undefined));
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false });
      await channel.bindQueue(queue, this.exchange, 'transfer.#');
      await channel.consume(queue, (message) => message && this.handle(message.content), { noAck: true });
      this.connection = connection;
      this.log('Tiempo real: consumiendo eventos de transferencias');
    } catch (error) {
      this.log(`Tiempo real: RabbitMQ no disponible (${error instanceof Error ? error.message : String(error)})`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.connection = null;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
