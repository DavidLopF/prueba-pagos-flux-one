import type { PaymentLinkStatus, TransferStatus } from '../api/types';
import { LINK_STATUS_LABEL, STATUS_LABEL } from '../lib/format';

export function StatusBadge({ status }: { status: TransferStatus }) {
  return (
    <span className={`badge badge--${status.toLowerCase()}`} title={status}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function LinkStatusBadge({ status }: { status: PaymentLinkStatus }) {
  return (
    <span className={`badge badge--link-${status.toLowerCase()}`} title={status}>
      {LINK_STATUS_LABEL[status] ?? status}
    </span>
  );
}
