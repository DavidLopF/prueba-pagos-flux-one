import type { AuditEvent } from '../api/types';
import { EVENT_LABEL, formatDateTime } from '../lib/format';
import { StatusBadge } from './StatusBadge';

interface Props {
  /** null mientras llega la primera respuesta. */
  events: AuditEvent[] | null;
  error: string | null;
}

/** FE-03: línea de tiempo de eventos de auditoría (ya vienen ordenados por occurredAt ascendente). */
export function AuditTimeline({ events, error }: Props) {
  if (events === null) {
    return <p className="muted">{error ?? 'Cargando eventos…'}</p>;
  }

  return (
    <>
      {events.length === 0 ? (
        <p className="muted">Aún no hay eventos: llegan de forma asíncrona desde el servicio de auditoría.</p>
      ) : (
        <ol className="timeline" aria-label="Línea de tiempo de auditoría">
          {events.map((event) => (
            <li key={event.eventId} className="timeline__item">
              <div className="timeline__head">
                <strong>{EVENT_LABEL[event.eventType] ?? event.eventType}</strong>
                <StatusBadge status={event.status} />
              </div>
              <p className="timeline__meta">
                {formatDateTime(event.occurredAt)} · {event.actorId ? `actor ${event.actorId}` : 'sistema'}
              </p>
              {event.payload && Object.keys(event.payload).length > 0 && (
                <details className="timeline__payload">
                  <summary>Detalle</summary>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {error && <p className="muted">No se pudo actualizar la auditoría: {error}</p>}
    </>
  );
}
