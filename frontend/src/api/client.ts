import type {
  AuditEvent,
  Balance,
  CreatePaymentLinkRequest,
  CreateTransferRequest,
  ErrorBody,
  PaymentLink,
  PublicPaymentLink,
  TokenPair,
  Transfer,
  User,
} from './types';

// Todas las llamadas van a /api en el mismo origen: nginx (contenedor) o Vite (dev) las reenvían.
const BASE_URL = '/api';
const ACCESS_TOKEN = 'portal.accessToken';
const REFRESH_TOKEN = 'portal.refreshToken';

/** Respuesta HTTP no exitosa con el cuerpo { code, message } del contrato. Un fallo de red NO es ApiError. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------- Sesión: tokens en sessionStorage (se pierden al cerrar la pestaña) ----------

function saveTokens(tokens: TokenPair): void {
  sessionStorage.setItem(ACCESS_TOKEN, tokens.accessToken);
  sessionStorage.setItem(REFRESH_TOKEN, tokens.refreshToken);
}

function clearTokens(): void {
  sessionStorage.removeItem(ACCESS_TOKEN);
  sessionStorage.removeItem(REFRESH_TOKEN);
}

export function getAccessToken(): string | null {
  return sessionStorage.getItem(ACCESS_TOKEN);
}

export function isLoggedIn(): boolean {
  return getAccessToken() !== null;
}

let sessionExpiredListener: (() => void) | null = null;

/** La app registra qué hacer si la sesión no se puede renovar (ir al login). Devuelve la función para quitarlo. */
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListener = listener;
  return () => {
    if (sessionExpiredListener === listener) sessionExpiredListener = null;
  };
}

/** La sesión ya no se puede renovar: se borra y la app vuelve al login. */
export function expireSession(): void {
  clearTokens();
  sessionExpiredListener?.();
}

// ---------- Núcleo HTTP ----------

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  /** false en login/logout: sin Bearer y sin intento de refresh ante un 401. */
  auth?: boolean;
}

function send(path: string, { method = 'GET', body, idempotencyKey, auth = true }: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const accessToken = getAccessToken();
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Rota el par de tokens. Si varias peticiones reciben 401 a la vez (p. ej. el polling del estado y el de
 * auditoría) comparten UN solo refresh: el refresh token se rota en cada uso, así que dos refresh
 * simultáneos con el mismo token harían fallar al segundo y cerrarían la sesión sin motivo.
 */
function refreshTokens(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    const refreshToken = sessionStorage.getItem(REFRESH_TOKEN);
    if (!refreshToken) return false;
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;
    saveTokens((await response.json()) as TokenPair);
    return true;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Para el WebSocket (cierre 4401, RT-02): renueva el access token con el MISMO refresh compartido que usan las
 * peticiones HTTP. Si el servidor lo rechaza, cierra la sesión (→ login) y devuelve false. Un error de red se
 * propaga: no es motivo para cerrar la sesión.
 */
export async function renewSession(): Promise<boolean> {
  if (await refreshTokens()) return true;
  expireSession();
  return false;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  // 401 = access token vencido (dura 15 min) o inválido: UN refresh y se repite la petición UNA vez.
  // Repetir es seguro incluso en un POST: el 401 se da antes de procesar nada y el reintento lleva la
  // misma Idempotency-Key. Si el refresh falla, se borra la sesión y la app vuelve al login.
  if (response.status === 401 && options.auth !== false) {
    if (await refreshTokens()) response = await send(path, options);
    if (response.status === 401) expireSession();
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  // Un 5xx del propio gateway (nginx) trae HTML en vez del JSON { code, message } del contrato.
  const body = (await response.json().catch(() => null)) as Partial<ErrorBody> | null;
  return new ApiError(
    response.status,
    body?.code ?? `HTTP_${response.status}`,
    body?.message ?? `Error HTTP ${response.status}`,
  );
}

// ---------- Endpoints del contrato (docs/openapi.yaml) ----------

export const api = {
  async login(email: string, password: string): Promise<void> {
    saveTokens(await request<TokenPair>('/auth/login', { method: 'POST', body: { email, password }, auth: false }));
  },
  me: () => request<User>('/auth/me'),
  accounts: () => request<Balance[]>('/accounts'),
  transfers: (accountId: string) => request<Transfer[]>(`/transfers?account=${encodeURIComponent(accountId)}`),
  transfer: (id: string) => request<Transfer>(`/transfers/${encodeURIComponent(id)}`),
  createTransfer: (body: CreateTransferRequest, idempotencyKey: string) =>
    request<Transfer>('/transfers', { method: 'POST', body, idempotencyKey }),
  reverseTransfer: (id: string, idempotencyKey: string) =>
    request<Transfer>(`/transfers/${encodeURIComponent(id)}/reversal`, { method: 'POST', idempotencyKey }),
  auditEvents: (transferId: string) =>
    request<AuditEvent[]>(`/audit/transfers/${encodeURIComponent(transferId)}/events`),

  // Payment links (PL). Crear un link no mueve dinero: el contrato no le pide Idempotency-Key.
  createPaymentLink: (body: CreatePaymentLinkRequest) =>
    request<PaymentLink>('/payment-links', { method: 'POST', body }),
  paymentLinks: (accountId: string) =>
    request<PaymentLink[]>(`/payment-links?account=${encodeURIComponent(accountId)}`),
  /** PL-02: público, se consulta SIN token (funciona sin sesión). */
  publicPaymentLink: (id: string) =>
    request<PublicPaymentLink>(`/payment-links/${encodeURIComponent(id)}/public`, { auth: false }),
  /** PL-03: el pago SÍ mueve dinero → Idempotency-Key obligatoria. Devuelve la transferencia INTERNAL creada. */
  payPaymentLink: (id: string, fromAccount: string, idempotencyKey: string) =>
    request<Transfer>(`/payment-links/${encodeURIComponent(id)}/pay`, {
      method: 'POST',
      body: { fromAccount },
      idempotencyKey,
    }),
};

/** Revoca el refresh token en el servidor (best effort) y borra la sesión local. */
export async function logout(): Promise<void> {
  const refreshToken = sessionStorage.getItem(REFRESH_TOKEN);
  clearTokens();
  if (refreshToken) {
    await request('/auth/logout', { method: 'POST', body: { refreshToken }, auth: false }).catch(() => undefined);
  }
}

// ---------- Mensajes de error para el usuario ----------

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email o contraseña incorrectos.',
  UNAUTHORIZED: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  FORBIDDEN_ACCOUNT: 'No puedes operar ni consultar esa cuenta.',
  NOT_FOUND: 'No encontramos la transferencia (o no tienes acceso a ella).',
  ACCOUNT_NOT_FOUND: 'La cuenta no existe.',
  INVALID_AMOUNT: 'Monto inválido: debe ser mayor que 0 y tener máximo 2 decimales.',
  INSUFFICIENT_FUNDS: 'Saldo insuficiente para completar la operación.',
  SAME_ACCOUNT: 'La cuenta de origen y la de destino deben ser distintas.',
  INVALID_STATE: 'La transferencia ya no está en un estado que permita esta operación.',
  IDEMPOTENCY_KEY_REUSED:
    'Esta solicitud ya se había registrado con otros datos. Revisa tu historial antes de volver a intentarlo.',
  PAYMENT_LINK_EXPIRED: 'El link de pago está vencido.',
};

/** Texto para el usuario a partir de cualquier error de una llamada a la API. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'No hay conexión con el servidor.';
  return (
    ERROR_MESSAGES[error.code] ??
    (error.status >= 500 ? `El servidor no pudo responder (HTTP ${error.status}).` : error.message)
  );
}
