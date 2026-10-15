import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, describeError } from '../api/client';
import type { Balance, PaymentLink } from '../api/types';
import { formatDateTime } from '../lib/format';
import { formatCOP, isValidAmount } from '../lib/money';
import { LinkStatusBadge } from './StatusBadge';

const MAX_DESCRIPTION = 140; // CreatePaymentLinkRequest.description: 1..140 caracteres

/** URL pública que se comparte con quien va a pagar (ruta /pay/:id de esta SPA, PL-02). */
const shareUrl = (id: string) => `${window.location.origin}/pay/${id}`;

interface Props {
  accounts: Balance[];
  /** Cuenta seleccionada en el panel: la lista muestra sus links (PL-06). */
  selected: string | null;
}

/** "Cobrar con link": crear un link (PL-01) y ver los links de la cuenta seleccionada (PL-06). */
export function PaymentLinks({ accounts, selected }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<PaymentLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [links, setLinks] = useState<PaymentLink[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Misma guarda síncrona que FE-01: un doble clic no crea dos links. (Crear un link no mueve dinero,
  // por eso el contrato no pide Idempotency-Key aquí; el pago del link sí la lleva.)
  const inFlight = useRef(false);

  const listAccount = selected ?? accounts[0]?.accountId ?? null;

  useEffect(() => {
    if (!listAccount) return;
    let cancelled = false;
    api.paymentLinks(listAccount).then(
      (list) => {
        if (cancelled) return;
        setLinks(list);
        setListError(null);
      },
      (err: unknown) => {
        if (!cancelled) setListError(describeError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [listAccount, reloads]);

  function validate(): string | null {
    if (!isValidAmount(amount.trim())) {
      return 'Monto inválido: debe ser mayor que 0, con punto decimal y máximo 2 decimales (ej. 25000.00).';
    }
    const text = description.trim();
    if (!text) return 'Escribe una descripción, p. ej. "Factura 123".';
    if (text.length > MAX_DESCRIPTION) return `La descripción admite máximo ${MAX_DESCRIPTION} caracteres.`;
    return null;
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }

    inFlight.current = true;
    setCreating(true);
    setError(null);
    try {
      const link = await api.createPaymentLink({
        accountId,
        amount: amount.trim(),
        description: description.trim(),
      });
      setCreated(link);
      setCopiedId(null);
      setAmount('');
      setDescription('');
      setReloads((n) => n + 1); // la lista ya incluye el link nuevo
    } catch (err) {
      setError(describeError(err));
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }

  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(id));
      setCopiedId(id);
    } catch {
      // Sin portapapeles (solo existe en https o localhost): la URL sigue visible para copiarla a mano.
    }
  }

  const amountPreview = isValidAmount(amount.trim()) ? ` · cobrarás ${formatCOP(amount.trim())}` : '';

  return (
    <>
      <form className="link-form" onSubmit={handleCreate} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="link-account">
            Cuenta que recibe
          </label>
          <select id="link-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.accountId}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="link-amount">
            Monto a cobrar (COP)
          </label>
          <input
            id="link-amount"
            value={amount}
            placeholder="25000.00"
            inputMode="decimal"
            autoComplete="off"
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className="field field--wide">
          <label className="field__label" htmlFor="link-description">
            Descripción
          </label>
          <input
            id="link-description"
            value={description}
            placeholder="Factura 123"
            maxLength={MAX_DESCRIPTION}
            autoComplete="off"
            onChange={(e) => setDescription(e.target.value)}
          />
          <small className="field__hint">
            {description.trim().length}/{MAX_DESCRIPTION}
            {amountPreview}
          </small>
        </div>

        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? 'Creando…' : 'Crear link'}
        </button>
      </form>

      {created && (
        <div className="share" role="status">
          <p className="share__title">
            Link creado por {formatCOP(created.amount)} · vence {formatDateTime(created.expiresAt)}
          </p>
          <div className="share__row">
            <input
              readOnly
              aria-label="Link para compartir"
              value={shareUrl(created.id)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(created.id)}>
              {copiedId === created.id ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <p className="field__hint">Compártelo con quien te va a pagar: es de un solo uso.</p>
        </div>
      )}

      <div className="links-block">
        <h3 className="card__subtitle">Links de {listAccount}</h3>
        {listError && (
          <p className="alert alert--error" role="alert">
            {listError}
          </p>
        )}
        {links === null ? (
          <p className="muted">Cargando links…</p>
        ) : links.length === 0 ? (
          <p className="muted">Todavía no has creado links de cobro para esta cuenta.</p>
        ) : (
          <ul className="links" aria-label="Links de cobro">
            {links.map((link) => (
              <li key={link.id} className="links__row">
                <span className="links__main">
                  <strong>{link.description}</strong>
                  <span className="muted">
                    {link.status === 'ACTIVE' && `Vence ${formatDateTime(link.expiresAt)}`}
                    {link.status === 'EXPIRED' && `Venció ${formatDateTime(link.expiresAt)}`}
                    {link.status === 'PAID' && `Creado ${formatDateTime(link.createdAt)}`}
                  </span>
                </span>
                <span className="links__amount">{formatCOP(link.amount)}</span>
                <LinkStatusBadge status={link.status} />
                <span className="links__action">
                  {link.status === 'PAID' && link.paidTransferId && (
                    <Link to={`/transfers/${link.paidTransferId}`}>Ver pago</Link>
                  )}
                  {link.status === 'ACTIVE' && (
                    <button type="button" className="link-button" onClick={() => copy(link.id)}>
                      {copiedId === link.id ? 'Copiado' : 'Copiar link'}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
