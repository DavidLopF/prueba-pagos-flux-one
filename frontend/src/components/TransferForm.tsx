import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, describeError } from '../api/client';
import type { Balance, TransferType } from '../api/types';
import { TYPE_LABEL } from '../lib/format';
import { formatCOP, isValidAmount } from '../lib/money';

const newKey = () => crypto.randomUUID();

/** FE-01: formulario de nueva transferencia sin doble envío. */
export function TransferForm({ accounts }: { accounts: Balance[] }) {
  const navigate = useNavigate();
  const [type, setType] = useState<TransferType>('INTERNAL');
  const [fromAccount, setFromAccount] = useState(accounts[0]?.accountId ?? '');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Idempotency-Key = un intento lógico del usuario. Se genera al abrir el formulario y:
  //  - se CONSERVA tras un error de red o 5xx: la petición pudo haberse procesado y solo la misma key
  //    hace que el reintento no cree una segunda transferencia (el backend repite la respuesta guardada);
  //  - se RENUEVA tras crear la transferencia, o cuando el usuario edita el formulario después de un 4xx
  //    definitivo (la misma key con otro payload sería rechazada con 422 IDEMPOTENCY_KEY_REUSED).
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const newKeyOnNextEdit = useRef(false);

  // Guarda síncrona contra doble clic: `submitting` deshabilita el botón, pero solo a partir del siguiente
  // render; un segundo clic en el mismo tick aún vería submitting=false. El ref cambia en el acto.
  const inFlight = useRef(false);

  function edited() {
    if (newKeyOnNextEdit.current) {
      newKeyOnNextEdit.current = false;
      setIdempotencyKey(newKey());
    }
  }

  function validate(): string | null {
    if (!toAccount.trim()) return 'Indica la cuenta de destino.';
    if (toAccount.trim() === fromAccount) return 'La cuenta de destino debe ser distinta a la de origen.';
    if (!isValidAmount(amount.trim())) {
      return 'Monto inválido: debe ser mayor que 0, con punto decimal y máximo 2 decimales (ej. 150000.50).';
    }
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const transfer = await api.createTransfer(
        { type, fromAccount, toAccount: toAccount.trim(), amount: amount.trim() },
        idempotencyKey,
      );
      setIdempotencyKey(newKey()); // intento terminado: el próximo envío es una operación nueva
      navigate(`/transfers/${transfer.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        newKeyOnNextEdit.current = true; // 4xx = respuesta definitiva del servidor
        setError(describeError(err));
      } else {
        setError(
          `${describeError(err)} Puedes reintentar: se reutiliza la misma clave de idempotencia, ` +
            'así que la transferencia no se duplicará.',
        );
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const amountPreview = isValidAmount(amount.trim()) ? formatCOP(amount.trim()) : null;

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <fieldset className="field">
        <legend className="field__label">Tipo</legend>
        <div className="segmented">
          {(['INTERNAL', 'EXTERNAL'] as const).map((option) => (
            <label key={option} className="segmented__option">
              <input
                type="radio"
                name="transfer-type"
                value={option}
                checked={type === option}
                onChange={() => {
                  setType(option);
                  edited();
                }}
              />
              {TYPE_LABEL[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label className="field__label" htmlFor="transfer-from">
          Desde
        </label>
        <select
          id="transfer-from"
          value={fromAccount}
          onChange={(e) => {
            setFromAccount(e.target.value);
            edited();
          }}
        >
          {accounts.map((account) => (
            <option key={account.accountId} value={account.accountId}>
              {`${account.accountId} · ${formatCOP(account.balance)}`}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="transfer-to">
          Cuenta destino
        </label>
        <input
          id="transfer-to"
          value={toAccount}
          placeholder={type === 'INTERNAL' ? 'ACC-002' : 'EXT-BANCO-123'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setToAccount(e.target.value);
            edited();
          }}
        />
        <small className="field__hint">
          {type === 'INTERNAL' ? 'Cuenta del portal: ACC-00x.' : 'Cuenta en otro banco, p. ej. EXT-BANCO-123.'}
        </small>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="transfer-amount">
          Monto (COP)
        </label>
        <input
          id="transfer-amount"
          value={amount}
          placeholder="150000.50"
          inputMode="decimal"
          autoComplete="off"
          onChange={(e) => {
            setAmount(e.target.value);
            edited();
          }}
        />
        <small className="field__hint">
          {amountPreview ? `Vas a enviar ${amountPreview}` : 'Punto como separador decimal, sin separador de miles.'}
        </small>
      </div>

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? 'Enviando…' : 'Enviar'}
      </button>
      <p className="form__key" title={idempotencyKey}>
        Idempotency-Key <code>{idempotencyKey.slice(0, 8)}…</code>
      </p>
    </form>
  );
}
