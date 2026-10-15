import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, describeError, isLoggedIn } from '../api/client';
import type { Balance, PublicPaymentLink } from '../api/types';
import { LinkStatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';
import { formatCOP } from '../lib/money';

const newKey = () => crypto.randomUUID();

/** Errores propios de un link (400 = id mal formado, 404 = no existe, 409 = ya pagado). */
function describeLinkError(err: unknown): string {
  if (err instanceof ApiError && (err.status === 400 || err.status === 404)) return 'Este link de pago no existe.';
  if (err instanceof ApiError && err.code === 'INVALID_STATE') return 'Este link ya fue pagado.';
  return describeError(err);
}

/** Ruta pública /pay/:id: se ve sin sesión (PL-02); para pagar (PL-03) hay que iniciar sesión. */
export function PayLinkPage() {
  const { id = '' } = useParams();
  return <PayLink key={id} id={id} />;
}

function PayLink({ id }: { id: string }) {
  const navigate = useNavigate();
  const loggedIn = isLoggedIn();
  const [link, setLink] = useState<PublicPaymentLink | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Balance[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [fromAccount, setFromAccount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  // Protección FE-01 aplicada al pago (PL-04): la key se genera al abrir la página; se CONSERVA tras un error
  // de red o 5xx (el pago pudo aplicarse: el reintento con la misma key no paga dos veces) y se RENUEVA tras
  // un 4xx definitivo (ese intento ya terminó; uno nuevo, p. ej. desde otra cuenta, es otra operación).
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  // Guarda síncrona contra doble clic (el botón deshabilitado solo llega en el siguiente render).
  const inFlight = useRef(false);

  // Datos públicos del link: se piden SIN token, así que funcionan también sin sesión.
  useEffect(() => {
    let cancelled = false;
    api.publicPaymentLink(id).then(
      (data) => {
        if (!cancelled) setLink(data);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(describeLinkError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Con sesión: mis cuentas, para elegir desde cuál pagar.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    api.accounts().then(
      (list) => {
        if (!cancelled) setAccounts(list);
      },
      (err: unknown) => {
        if (!cancelled) setAccountsError(describeError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

  // No se ofrece la cuenta que recibe el pago: pagarse a sí misma sería 422 SAME_ACCOUNT.
  const payable = (accounts ?? []).filter((account) => account.accountId !== link?.accountId);
  const from = fromAccount || payable[0]?.accountId || '';

  async function handlePay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !from) return;

    inFlight.current = true;
    setPaying(true);
    setError(null);
    try {
      const transfer = await api.payPaymentLink(id, from, idempotencyKey);
      setIdempotencyKey(newKey());
      navigate(`/transfers/${transfer.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        setIdempotencyKey(newKey()); // 4xx definitivo (saldo, vencido, ya pagado…): el intento terminó
        setError(describeLinkError(err));
        api.publicPaymentLink(id).then(setLink, () => undefined); // si quedó PAID/EXPIRED se oculta el botón
      } else {
        setError(
          `${describeError(err)} Puedes reintentar: se reutiliza la misma clave de idempotencia, ` +
            'así que el pago no se duplicará.',
        );
      }
    } finally {
      inFlight.current = false;
      setPaying(false);
    }
  }

  const loginUrl = `/login?next=${encodeURIComponent(`/pay/${id}`)}`;

  return (
    <div className="public">
      <section className="card public__card">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          Portal de pagos
        </Link>

        {link === null ? (
          loadError ? (
            <p className="alert alert--error" role="alert">
              {loadError}
            </p>
          ) : (
            <p className="muted">Cargando link de pago…</p>
          )
        ) : (
          <>
            <div className="detail__header">
              <div>
                <p className="eyebrow">Link de pago</p>
                <p className="detail__amount">
                  {formatCOP(link.amount)} <span className="detail__currency">COP</span>
                </p>
              </div>
              <LinkStatusBadge status={link.status} />
            </div>
            <p className="public__description">{link.description}</p>
            <dl className="fields">
              <div>
                <dt>Cuenta destino</dt>
                <dd>{link.accountId}</dd>
              </div>
              <div>
                <dt>Vence</dt>
                <dd>{formatDateTime(link.expiresAt)}</dd>
              </div>
            </dl>

            {link.status === 'PAID' && <p className="alert alert--info">Este link ya fue pagado.</p>}
            {link.status === 'EXPIRED' && (
              <p className="alert alert--warn">Este link venció y ya no se puede pagar.</p>
            )}

            {link.status === 'ACTIVE' && !loggedIn && (
              <Link to={loginUrl} className="btn btn--primary btn--block">
                Inicia sesión para pagar
              </Link>
            )}

            {link.status === 'ACTIVE' &&
              loggedIn &&
              (accounts === null ? (
                <p className="muted">{accountsError ?? 'Cargando tus cuentas…'}</p>
              ) : payable.length === 0 ? (
                <p className="alert alert--info">No tienes otra cuenta desde la cual pagar este link.</p>
              ) : (
                <form className="form" onSubmit={handlePay}>
                  <div className="field">
                    <label className="field__label" htmlFor="pay-from">
                      Pagar desde
                    </label>
                    <select id="pay-from" value={from} onChange={(e) => setFromAccount(e.target.value)}>
                      {payable.map((account) => (
                        <option key={account.accountId} value={account.accountId}>
                          {`${account.accountId} · ${formatCOP(account.balance)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  {error && (
                    <p className="alert alert--error" role="alert">
                      {error}
                    </p>
                  )}
                  <button type="submit" className="btn btn--primary btn--block" disabled={paying}>
                    {paying ? 'Pagando…' : 'Pagar'}
                  </button>
                  <p className="form__key" title={idempotencyKey}>
                    Idempotency-Key <code>{idempotencyKey.slice(0, 8)}…</code>
                  </p>
                </form>
              ))}
          </>
        )}
      </section>
    </div>
  );
}
