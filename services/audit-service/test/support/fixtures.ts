import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../../src/infrastructure/logger.js';

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const CAROL = '33333333-3333-4333-8333-333333333333';

export interface TransferEventOptions {
  eventId?: string;
  transferId?: string;
  eventType?: string;
  status?: string;
  occurredAt?: string;
  actorId?: string | null;
  participantIds?: string[];
}

/** A message exactly as payments-service publishes it on `payments.events`. */
export function transferEvent(options: TransferEventOptions = {}) {
  const transferId = options.transferId ?? randomUUID();
  return {
    eventId: options.eventId ?? randomUUID(),
    eventType: options.eventType ?? 'TRANSFER_CREATED',
    aggregateId: transferId,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    actorId: options.actorId === undefined ? ALICE : options.actorId,
    participantIds: options.participantIds ?? [ALICE, BOB],
    payload: {
      transferId,
      type: 'INTERNAL',
      fromAccount: 'ACC-001',
      toAccount: 'ACC-002',
      amount: '100000.50',
      status: options.status ?? 'PENDING',
      previousStatus: null,
    },
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await delay(100);
  }
}
