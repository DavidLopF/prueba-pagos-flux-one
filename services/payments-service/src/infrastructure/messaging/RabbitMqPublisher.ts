import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { MessagePublisher, OutgoingMessage } from './OutboxRelay.js';

const RECONNECT_DELAY_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Publicador con publisher confirms. `mandatory: true` hace que un mensaje sin cola destino vuelva
 * (basic.return) antes del ack: en ese caso se rechaza para que el outbox lo reintente y no se pierda.
 * Si el broker cae, reconecta solo; mientras tanto publish() falla y los eventos esperan en el outbox.
 */
export class RabbitMqPublisher implements MessagePublisher {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private readonly returned = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly exchange: string,
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

  async publish(message: OutgoingMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      throw new Error('RabbitMQ no disponible');
    }
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        channel.publish(
          this.exchange,
          message.routingKey,
          message.body,
          { persistent: true, mandatory: true, contentType: 'application/json', messageId: message.messageId },
          (error) => {
            if (error) return reject(error instanceof Error ? error : new Error(String(error)));
            if (this.returned.delete(message.messageId)) {
              return reject(new Error(`Sin cola destino para ${message.routingKey}`));
            }
            resolve();
          },
        );
      }),
      CONFIRM_TIMEOUT_MS,
    );
  }

  private async connect(): Promise<void> {
    try {
      const connection = await amqp.connect(this.url);
      connection.on('error', (error: Error) => this.log(`RabbitMQ error: ${error.message}`));
      connection.on('close', () => this.scheduleReconnect());
      const channel = await connection.createConfirmChannel();
      channel.on('error', (error: Error) => this.log(`RabbitMQ channel error: ${error.message}`));
      channel.on('close', () => void connection.close().catch(() => undefined));
      channel.on('return', (msg: amqp.Message) => {
        const id = msg.properties.messageId as string | undefined;
        if (id) this.returned.add(id);
      });
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      this.connection = connection;
      this.channel = channel;
      this.log('RabbitMQ conectado');
    } catch (error) {
      this.log(`RabbitMQ no disponible: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.channel = null;
    this.connection = null;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout esperando confirmación del broker')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
