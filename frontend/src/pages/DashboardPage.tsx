import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeError } from '../api/client';
import type { Balance, Transfer } from '../api/types';
import { PaymentLinks } from '../components/PaymentLinks';
import { StatusBadge } from '../components/StatusBadge';
import { TransferForm } from '../components/TransferForm';
import { TYPE_LABEL, formatDateTime } from '../lib/format';
import { formatCOP } from '../lib/money';

export function DashboardPage() {
  const [accounts, setAccounts] = useState<Balance[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0); // cada clic en "Actualizar" vuelve a cargar todo

  useEffect(() => {
    let cancelled = false;
    api.accounts().then(
      (list) => {
        if (cancelled) return;
        setAccounts(list);
        setSelected((current) => current ?? list[0]?.accountId ?? null);
      },
      (err: unknown) => {
        if (!cancelled) setError(describeError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // Historial de la cuenta seleccionada (TR-09: enviadas y recibidas, más recientes primero).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api.transfers(selected).then(
      (list) => {
        if (!cancelled) setTransfers(list);
      },
      (err: unknown) => {
        if (!cancelled) setError(describeError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected, reloads]);

  function selectAccount(accountId: string) {
    if (accountId === selected) return;
    setTransfers(null);
    setSelected(accountId);
  }

  function reload() {
    setError(null);
    setReloads((n) => n + 1);
  }

  return (
    <div className="dashboard">
      <div className="dashboard__side">
        <section className="card">
          <h2 className="card__title">Mis cuentas</h2>
          {accounts === null ? (
            <p className="muted">Cargando cuentas…</p>
          ) : (
            <ul className="accounts">
              {accounts.map((account) => (
                <li key={account.accountId}>
                  <button
                    type="button"
                    className={`account${account.accountId === selected ? ' account--selected' : ''}`}
                    aria-pressed={account.accountId === selected}
                    onClick={() => selectAccount(account.accountId)}
                  >
                    <span className="account__id">{account.accountId}</span>
                    <span className="account__balance">{formatCOP(account.balance)}</span>
                    <span className="account__caption">Saldo disponible · COP</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">Nueva transferencia</h2>
          {accounts && accounts.length > 0 ? (
            <TransferForm accounts={accounts} />
          ) : (
            <p className="muted">Necesitas una cuenta para transferir.</p>
          )}
        </section>
      </div>

      <div className="dashboard__main">
        <section className="card">
          <div className="card__header">
            <h2 className="card__title">
              Movimientos {selected && <span className="muted">· {selected}</span>}
            </h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
              Actualizar
            </button>
          </div>
          {error && (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}
          {transfers === null ? (
            <p className="muted">Cargando movimientos…</p>
          ) : transfers.length === 0 ? (
            <p className="muted">Todavía no hay movimientos en esta cuenta.</p>
          ) : (
            <ul className="history">
              {transfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} accountId={selected ?? ''} />
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">Cobrar con link</h2>
          {accounts && accounts.length > 0 ? (
            <PaymentLinks accounts={accounts} selected={selected} />
          ) : (
            <p className="muted">Necesitas una cuenta para cobrar.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function TransferRow({ transfer, accountId }: { transfer: Transfer; accountId: string }) {
  const outgoing = transfer.fromAccount === accountId;
  return (
    <li>
      <Link to={`/transfers/${transfer.id}`} className="history__row">
        <span className="history__main">
          <strong>{outgoing ? `Enviada a ${transfer.toAccount}` : `Recibida de ${transfer.fromAccount}`}</strong>
          <span className="muted">
            {TYPE_LABEL[transfer.type]} · {formatDateTime(transfer.createdAt)}
          </span>
        </span>
        <span className={`history__amount ${outgoing ? 'is-out' : 'is-in'}`}>
          {outgoing ? '−' : '+'} {formatCOP(transfer.amount)}
        </span>
        <StatusBadge status={transfer.status} />
      </Link>
    </li>
  );
}
