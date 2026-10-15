import { useEffect, useRef, useState } from 'react';
import { expireSession, getAccessToken, renewSession } from '../api/client';
import type { AuditEventType, TransferStatus } from '../api/types';

export type ConnectionState = 'connecting' | 'live' | 'offline';

/** Aviso del servidor (RT-01): solo dice QUÉ transferencia cambió; los datos se vuelven a pedir a la API. */
export interface TransferUpdate {
  type: 'transfer.updated';
  transferId: string;
  eventType: AuditEventType;
  status: TransferStatus;
  occurredAt: string;
}

type ServerMessage = { type: 'ready' } | TransferUpdate;

interface Handlers {
  /** Llegó un aviso `transfer.updated`. */
  onUpdate: (update: TransferUpdate) => void;
  /** Conexión (re)establecida: mientras no había conexión pudieron perderse avisos. */
  onReady: () => void;
}

const AUTH_CLOSE_CODE = 4401; // RT-02: token ausente, inválido o vencido
const MAX_BACKOFF_MS = 30_000;

function socketUrl(token: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // Un WebSocket del navegador no admite headers: el JWT va en la query (nginx no la registra en su log).
  return `${scheme}://${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
}

function parse(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    return null; // un frame que no es JSON se ignora
  }
}

/**
 * FE-04 · Avisos en vivo de transferencias por WebSocket, mientras el componente esté montado:
 * - "ready" → estado 'live', se reinicia el backoff y se llama onReady (para ponerse al día);
 * - "transfer.updated" → onUpdate;
 * - cierre 4401 (RT-02) → renueva el token UNA vez con el refresh compartido de la API y reconecta; si no se
 *   puede renovar (o el token nuevo también se rechaza) la sesión se cierra como ante un HTTP 401 → login;
 * - cualquier otro cierre o error → reconecta con backoff exponencial: 1 s, 2 s, 4 s… máximo 30 s.
 * Al desmontar (también al cerrar sesión, que navega al login) se cierra el socket y no se reintenta más.
 */
export function useTransferUpdates(handlers: Handlers): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  // Siempre los handlers del último render, sin reabrir el socket cada vez que cambian.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0; // cierres seguidos sin "ready": definen la espera del backoff
    let renewed = false; // ya se renovó el token tras un 4401 y aún no hubo "ready"
    let stopped = false;

    function connect() {
      const token = getAccessToken();
      if (!token) {
        setState('offline'); // sin sesión no hay a qué conectarse (la app ya va al login)
        return;
      }
      setState('connecting');
      const ws = new WebSocket(socketUrl(token));
      socket = ws;

      ws.onmessage = (event) => {
        if (stopped) return;
        const message = parse(event.data);
        if (message?.type === 'ready') {
          failures = 0;
          renewed = false;
          setState('live');
          handlersRef.current.onReady();
        } else if (message?.type === 'transfer.updated') {
          handlersRef.current.onUpdate(message);
        }
      };

      // Tras un error siempre llega un close, así que la reconexión se decide solo aquí.
      ws.onclose = (event) => {
        if (stopped) return;
        socket = null;
        setState('offline');
        if (event.code !== AUTH_CLOSE_CODE) {
          renewed = false;
          scheduleReconnect();
        } else if (!renewed) {
          renewed = true;
          void renewAndReconnect();
        } else {
          expireSession(); // el token recién renovado también se rechazó: como un 401 tras el reintento
        }
      };
    }

    function scheduleReconnect() {
      const delay = Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS);
      failures += 1;
      retryTimer = setTimeout(connect, delay);
    }

    async function renewAndReconnect() {
      try {
        // false = el servidor rechazó el refresh: renewSession ya cerró la sesión (la app va al login).
        if ((await renewSession()) && !stopped) connect();
      } catch {
        if (!stopped) scheduleReconnect(); // red caída durante el refresh: se reintenta con backoff
      }
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return state;
}
