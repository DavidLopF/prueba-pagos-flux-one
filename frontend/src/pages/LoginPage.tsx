import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, describeError, isLoggedIn } from '../api/client';
import { formatCOP } from '../lib/money';

/** ?next= solo acepta rutas internas ("/pay/…"): así no sirve para redirigir a otro sitio (?next=//otro.com). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

// Usuarios seed de la demo (docs/spec.md · Datos iniciales).
const DEMO_PASSWORD = 'Demo1234!';
const DEMO_USERS = [
  { email: 'alice@demo.co', account: 'ACC-001', balance: '1000000.00' },
  { email: 'bob@demo.co', account: 'ACC-002', balance: '500000.00' },
  { email: 'carol@demo.co', account: 'ACC-003', balance: '0.00' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionExpired = (location.state as { sessionExpired?: boolean } | null)?.sessionExpired === true;
  // A dónde volver tras el login (p. ej. /pay/:id cuando alguien abre un link de pago sin sesión).
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (isLoggedIn()) return <Navigate to={next} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <section className="card login__card">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          Portal de pagos
        </div>
        <h1 className="login__title">Inicia sesión</h1>
        {sessionExpired && <p className="alert alert--info">Tu sesión expiró. Vuelve a iniciar sesión.</p>}
        {next.startsWith('/pay/') && (
          <p className="alert alert--info">Inicia sesión para continuar con el pago del link.</p>
        )}

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="login-password">
              Contraseña
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? 'Ingresando…' : 'Ingresar'}
          </button>
        </form>

        <div className="demo">
          <p className="demo__title">Usuarios de prueba (demo)</p>
          <p className="muted">
            Contraseña: <code>{DEMO_PASSWORD}</code> · clic para completar el formulario.
          </p>
          <ul className="demo__list">
            {DEMO_USERS.map((user) => (
              <li key={user.email}>
                <button
                  type="button"
                  className="demo__user"
                  onClick={() => {
                    setEmail(user.email);
                    setPassword(DEMO_PASSWORD);
                  }}
                >
                  <span>{user.email}</span>
                  <span className="muted">
                    {user.account} · {formatCOP(user.balance)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
