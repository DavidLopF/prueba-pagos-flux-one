import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, describeError } from '../api/client';
import { isStable, type AuditEvent, type Transfer } from '../api/types';
import { AuditTimeline } from '../components/AuditTimeline';
import { StatusBadge } from '../components/StatusBadge';
import { TYPE_LABEL, formatDateTime } from '../lib/format';
import { formatCOP } from '../lib/money';

const STATUS_POLL_MS = 1500; // FE-02
const AUDIT_POLL_MS = 3000; // FE-03

const newKey = () => crypto.randomUUID();

export function TransferDetailPage() {
  const { id = '' } = useParams();
  // key={id}: si cambia la URL se monta un detalle nuevo (estado y polling empiezan de cero).
  return <TransferDetail key={id} id={id} />;
}

function TransferDetail({ id }: { id: string }) {
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  // Reverso: misma protección que FE-01 (guarda con ref + botón deshabilitado) y su propia Idempotency-Key.
  const [reversalKey, setReversalKey] = useState(newKey);
  const [reversing, setReversing] = useState(false);
  const [reversalError, setReversalError] = useState<string | null>(null);
  const reversalInFlight = useRef(false);
  const [myAccounts, setMyAccounts] = useState<string[] | null>(null);

  const stable = transfer !== null && isStable(transfer.status);

  // Solo el dueño de la cuenta origen puede reversar (a cualquier otro, p. ej. quien recibió un pago, el
  // backend le responde 404). Mis cuentas se piden UNA vez al montar, no en cada consulta del polling.
  useEffect(() => {
    let cancelled = false;
    api.accounts().then(
      (list) => {
        if (!cancelled) setMyAccounts(list.map((account) => account.accountId));
      },
      () => undefined, // sin la lista no se ofrece el reverso
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // FE-02 · Polling del estado. Mientras NO sea estable se consulta ya y luego cada 1,5 s con un setTimeout
  // encadenado (la siguiente consulta sale cuando terminó la anterior: nunca se solapan). Al llegar a
  // COMPLETED/FAILED/REVERSED no se programa otra consulta y `stable` pasa a true, así que el efecto no
  // vuelve a arrancar. Un reverso deja el estado en REVERSAL_PENDING → `stable` vuelve a false → el efecto
  // arranca de nuevo. Al desmontar, la limpieza cancela el timer y descarta la respuesta en vuelo.
  useEffect(() => {
    if (stable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const latest = await api.transfer(id);
        if (cancelled) return;
        setTransfer(latest);
        setLoadError(null);
        if (isStable(latest.status)) return;
      } catch (err) {
        if (cancelled) return;
        setLoadError(describeError(err));
        if (err instanceof ApiError && err.status < 500) return; // 4xx (p. ej. 404): reintentar no cambia nada
      }
      timer = setTimeout(poll, STATUS_POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, stable]);

  // FE-03 · Auditoría. Los eventos viajan payments → outbox → RabbitMQ → audit: llegan con retraso y por
  // su cuenta (el último suele llegar DESPUÉS de que el estado ya es estable, y mucho después si el broker
  // estuvo caído, AUD-02). Lo más simple que garantiza verlos todos es refrescar la línea de tiempo cada 3 s
  // mientras la página esté abierta: es un GET pequeño y se detiene al salir de la página.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const latest = await api.auditEvents(id);
        if (cancelled) return;
        setEvents(latest);
        setAuditError(null);
      } catch (err) {
        if (cancelled) return;
        setAuditError(describeError(err));
      }
      timer = setTimeout(load, AUDIT_POLL_MS);
    };

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function handleReverse() {
    if (reversalInFlight.current) return;
    reversalInFlight.current = true;
    setReversing(true);
    setReversalError(null);
    try {
      // 200 REVERSED (interna) o 202 REVERSAL_PENDING (externa: el polling se reanuda solo).
      setTransfer(await api.reverseTransfer(id, reversalKey));
      setReversalKey(newKey()); // si el banco rechaza este reverso, el siguiente intento es otra operación
    } catch (err) {
      setReversalError(describeError(err));
      if (err instanceof ApiError && err.status < 500) {
        // Respuesta definitiva (409 INVALID_STATE, 422 INSUFFICIENT_FUNDS): un nuevo intento es otra
        // operación → key nueva. Y se recarga el estado real (p. ej. ya había un reverso en curso).
        setReversalKey(newKey());
        api.transfer(id).then(setTransfer, () => undefined);
      }
      // Red/5xx: se conserva la key, así el reintento no puede crear un segundo reverso.
    } finally {
      reversalInFlight.current = false;
      setReversing(false);
    }
  }

  if (!transfer) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          ← Volver al panel
        </Link>
        {loadError ? (
          <p className="alert alert--error" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Cargando transferencia…</p>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← Volver al panel
      </Link>

      <section className="card">
        <div className="detail__header">
          <div>
            <p className="eyebrow">Transferencia {TYPE_LABEL[transfer.type].toLowerCase()}</p>
            <p className="detail__amount">
              {formatCOP(transfer.amount)} <span className="detail__currency">COP</span>
            </p>
          </div>
          <div aria-live="polite">
            <StatusBadge status={transfer.status} />
          </div>
        </div>

        {transfer.status === 'UNKNOWN' && (
          <p className="alert alert--warn">
            Confirmando con el banco… No recibimos respuesta a tiempo; el dinero sigue retenido hasta que el banco
            confirme si procesó la transferencia.
          </p>
        )}
        {transfer.status === 'REVERSAL_PENDING' && (
          <p className="alert alert--info">Reverso en curso: esperando la confirmación del banco.</p>
        )}
        {transfer.requiresManualReview && (
          <p className="alert alert--error">
            Requiere revisión manual: el banco no confirmó el resultado tras varios intentos. El dinero permanece
            retenido; nunca se resuelve por suposición.
          </p>
        )}
        {!stable && <p className="live">Actualizando estado cada 1,5 s…</p>}
        {loadError && (
          <p className="alert alert--error" role="alert">
            {loadError}
          </p>
        )}

        <dl className="fields">
          <div>
            <dt>ID</dt>
            <dd className="mono">{transfer.id}</dd>
          </div>
          <div>
            <dt>Origen</dt>
            <dd>{transfer.fromAccount}</dd>
          </div>
          <div>
            <dt>Destino</dt>
            <dd>{transfer.toAccount}</dd>
          </div>
          {transfer.type === 'EXTERNAL' && (
            <div>
              <dt>Intentos con el banco</dt>
              <dd>{transfer.attempts}</dd>
            </div>
          )}
          {transfer.failureReason && (
            <div>
              <dt>Motivo</dt>
              <dd>{transfer.failureReason}</dd>
            </div>
          )}
          <div>
            <dt>Creada</dt>
            <dd>{formatDateTime(transfer.createdAt)}</dd>
          </div>
          <div>
            <dt>Actualizada</dt>
            <dd>{formatDateTime(transfer.updatedAt)}</dd>
          </div>
        </dl>

        {transfer.status === 'COMPLETED' && myAccounts?.includes(transfer.fromAccount) && (
          <div className="detail__actions">
            <button type="button" className="btn btn--danger" disabled={reversing} onClick={handleReverse}>
              {reversing ? 'Reversando…' : 'Reversar'}
            </button>
          </div>
        )}
        {reversalError && (
          <p className="alert alert--error" role="alert">
            {reversalError}
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Auditoría</h2>
        <AuditTimeline events={events} error={auditError} />
      </section>
    </div>
  );
}
