import { InvalidAuditEventError } from './errors.js';

export const AUDIT_EVENT_TYPES = [
  'TRANSFER_CREATED',
  'TRANSFER_COMPLETED',
  'TRANSFER_FAILED',
  'TRANSFER_UNKNOWN',
  'TRANSFER_REVERSAL_REQUESTED',
  'TRANSFER_REVERSED',
  'TRANSFER_REVERSAL_REJECTED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const TRANSFER_STATUSES = [
  'PENDING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED',
  'REVERSAL_PENDING',
  'REVERSED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Immutable record of one state change of a transfer, as published by payments-service. */
export interface AuditEvent {
  readonly eventId: string;
  readonly transferId: string;
  readonly eventType: AuditEventType;
  /** Status of the transfer right after this event (taken from `payload.status`). */
  readonly status: TransferStatus;
  /** User that triggered the change; null when it was the system (rail worker). */
  readonly actorId: string | null;
  /** Owners of the accounts involved: the only users allowed to read this event. */
  readonly participantIds: readonly string[];
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 instant with an explicit offset, so it can never be read as server-local time.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates a decoded `payments.events` message and maps it to an AuditEvent.
 * Throws InvalidAuditEventError describing the first problem found.
 */
export function parseAuditEvent(message: unknown): AuditEvent {
  if (!isRecord(message)) throw invalid('message must be a JSON object');
  const { eventId, eventType, aggregateId, occurredAt, actorId, participantIds, payload } = message;

  if (!isUuid(eventId)) throw invalid('eventId must be a UUID');
  if (!isOneOf(eventType, AUDIT_EVENT_TYPES)) throw invalid('eventType is not a known transfer event');
  if (!isUuid(aggregateId)) throw invalid('aggregateId must be a UUID');
  if (typeof occurredAt !== 'string' || !ISO_INSTANT.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    throw invalid('occurredAt must be an ISO-8601 date-time with offset');
  }
  if (actorId !== undefined && actorId !== null && !isUuid(actorId)) throw invalid('actorId must be a UUID or null');
  if (!Array.isArray(participantIds) || participantIds.length === 0 || !participantIds.every(isUuid)) {
    throw invalid('participantIds must be a non-empty array of UUIDs');
  }
  if (!isRecord(payload)) throw invalid('payload must be an object');
  if (!isOneOf(payload.status, TRANSFER_STATUSES)) throw invalid('payload.status is not a known transfer status');

  return {
    eventId,
    transferId: aggregateId,
    eventType,
    status: payload.status,
    actorId: actorId ?? null,
    participantIds: [...participantIds],
    occurredAt: new Date(occurredAt),
    payload,
  };
}

function invalid(reason: string): InvalidAuditEventError {
  return new InvalidAuditEventError(reason);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
