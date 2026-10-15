/**
 * Ejecuta `task` en bucle cada `intervalMs` (sin solaparse). `wake()` adelanta la próxima ejecución,
 * p. ej. justo después de crear una transferencia externa.
 */
export class PollingWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    this.schedule(0);
  }

  wake(): void {
    if (this.running || this.stopped) return; // el ciclo en curso o el siguiente lo recogerán
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = null;
      this.schedule(this.intervalMs);
    }
  }
}
