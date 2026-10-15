import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { api, isLoggedIn, logout, onSessionExpired } from './api/client';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PayLinkPage } from './pages/PayLinkPage';
import { TransferDetailPage } from './pages/TransferDetailPage';

export function App() {
  const navigate = useNavigate();

  // Si un 401 no se resuelve con el refresh, el cliente HTTP borra la sesión y avisa aquí → login.
  useEffect(
    () => onSessionExpired(() => navigate('/login', { replace: true, state: { sessionExpired: true } })),
    [navigate],
  );

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Pública: un link de pago se abre aun sin sesión (PL-02). */}
      <Route path="/pay/:id" element={<PayLinkPage />} />
      <Route element={<PrivateLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/transfers/:id" element={<TransferDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Rutas privadas: sin sesión → login; con sesión → cabecera + página. */
function PrivateLayout() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) return;
    let cancelled = false;
    api.me().then(
      (user) => {
        if (!cancelled) setEmail(user.email);
      },
      () => undefined, // solo informativo: si falla, la cabecera no muestra el email
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isLoggedIn()) return <Navigate to="/login" replace />;

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand">
            <span className="brand__mark" aria-hidden="true" />
            Portal de pagos
          </Link>
          <div className="topbar__session">
            {email && <span className="topbar__email">{email}</span>}
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleLogout}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
