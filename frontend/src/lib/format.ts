import type { AuditEventType, PaymentLinkStatus, TransferStatus, TransferType } from '../api/types';

// Textos en español para los enums del contrato.

export const STATUS_LABEL: Record<TransferStatus, string> = {
  PENDING: 'Pendiente',
  UNKNOWN: 'Por confirmar',
  COMPLETED: 'Completada',
  FAILED: 'Fallida',
  REVERSAL_PENDING: 'Reverso en curso',
  REVERSED: 'Reversada',
};

export const LINK_STATUS_LABEL: Record<PaymentLinkStatus, string> = {
  ACTIVE: 'Activo',
  PAID: 'Pagado',
  EXPIRED: 'Vencido',
};

export const TYPE_LABEL: Record<TransferType, string> = {
  INTERNAL: 'Interna',
  EXTERNAL: 'Externa',
};

export const EVENT_LABEL: Record<AuditEventType, string> = {
  TRANSFER_CREATED: 'Transferencia creada',
  TRANSFER_COMPLETED: 'Transferencia completada',
  TRANSFER_FAILED: 'Transferencia fallida',
  TRANSFER_UNKNOWN: 'Sin respuesta del banco: se confirmará',
  TRANSFER_REVERSAL_REQUESTED: 'Reverso solicitado',
  TRANSFER_REVERSED: 'Transferencia reversada',
  TRANSFER_REVERSAL_REJECTED: 'Reverso rechazado por el banco',
};

/** ISO-8601 → "15/10/2026, 8:37:05 a. m." en la zona horaria del navegador. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CO');
}
