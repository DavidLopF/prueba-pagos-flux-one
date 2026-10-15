# Mini portal de pagos — prueba SDD (fluxOne)

Tres microservicios hexagonales en **Node.js 22 + TypeScript** (Auth, Payments, Audit), un **riel bancario simulado**,
**PostgreSQL** con un esquema y un rol por servicio, **RabbitMQ** con **Transactional Outbox** y un frontend **React**.
Construido con Spec-Driven Development: `docs/spec.md` (criterios Given/When/Then con ID) → `docs/openapi.yaml`
→ tests que citan el ID → código. Reglas para agentes y humanos en [`CLAUDE.md`](./CLAUDE.md).

> **Demo en vivo (durante la evaluación):** https://98-81-60-52.sslip.io — `alice@demo.co` / `Demo1234!` (también `bob@` y `carol@`).
> AWS EC2 `t3.medium` en us-east-1, desplegado con `deploy/aws-ec2.sh`; HTTPS de Let's Encrypt y solo los puertos 80/443 abiertos.

## Levantar y probar (≤ 5 comandos)

```bash
git clone https://github.com/<usuario>/prueba-pagos-flux-one.git && cd prueba-pagos-flux-one
docker compose up --build -d          # postgres, rabbitmq, riel, auth, payments, audit y frontend
open http://localhost:8080            # alice@demo.co / Demo1234!  (también bob@ y carol@)
./scripts/test-all.sh                 # unitarios + aceptación (Testcontainers) + trazabilidad spec → test
```

| Servicio | URL host | Notas |
|---|---|---|
| Frontend + gateway `/api` | http://localhost:8080 | nginx hace proxy a los servicios |
| auth-service | http://localhost:3001 | `/auth/*` |
| payments-service | http://localhost:3002 | `/transfers`, `/accounts` |
| audit-service | http://localhost:3003 | `/audit/transfers/{id}/events` |
| Riel simulado | http://localhost:8081 | `PUT /rail/admin/mode` para forzar escenarios |
| RabbitMQ | http://localhost:15672 | guest / guest |
| PostgreSQL | localhost:55432 | postgres / postgres, BD `payments_portal` |

Datos iniciales: ACC-001 (alice) $1.000.000 · ACC-002 (bob) $500.000 · ACC-003 (carol) $0.

### Variables de entorno

- Cada servicio lee su configuración **solo de variables de entorno** en su `main.ts` (composition root) y falla al arrancar si falta una obligatoria; solo los valores no sensibles (puerto, timeouts) tienen default.
- `docker-compose.yml` inyecta las variables de cada servicio (cada uno con la `DATABASE_URL` de **su propio rol** de PostgreSQL). Los valores sensibles o ajustables se interpolan como `${JWT_SECRET:-…}`: sin configurar nada funciona, y para cambiarlos basta `cp .env.example .env` en la raíz (compose lo lee solo).
- Para correr un servicio **fuera de Docker** (`npm run dev`): `cp services/<svc>/.env.example services/<svc>/.env`; el script usa el flag nativo de Node `--env-file-if-exists` (sin dotenv) y apunta a la infraestructura de compose publicada en el host.
- Los `.env` están en `.gitignore` y en cada `.dockerignore`: ningún secreto llega al repositorio ni a las imágenes.

### Probar rápido con curl

```bash
TOKEN=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@demo.co","password":"Demo1234!"}' | jq -r .accessToken)
KEY=$(uuidgen)
# Repite este comando: la 2ª vez responde igual con Idempotent-Replayed: true y no vuelve a debitar.
curl -si localhost:8080/api/transfers -H "authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
  -H 'content-type: application/json' -d '{"type":"INTERNAL","fromAccount":"ACC-001","toAccount":"ACC-002","amount":"100000.50"}'
# Externa hacia el riel (el "to" con REJECT / DOWN / TIMEOUT / LOST fuerza el escenario):
curl -si localhost:8080/api/transfers -H "authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{"type":"EXTERNAL","fromAccount":"ACC-001","toAccount":"EXT-TIMEOUT-1","amount":"5000"}'
```

### Escenarios para la demo

| Qué mostrar | Cómo |
|---|---|
| Riel acepta / rechaza / caído / timeout procesado / timeout perdido | Transferencia **externa** con destino `EXT-OK-1`, `EXT-REJECT-1`, `EXT-DOWN-1`, `EXT-TIMEOUT-1` o `EXT-LOST-1` (los tokens son palabras completas) |
| Reverso externo rechazado por el banco | Externa a `EXT-OK-REVREJECT` y luego "Reversar" |
| Forzar el riel para todos | `curl -X PUT localhost:8081/rail/admin/mode -H 'content-type: application/json' -d '{"mode":"UNAVAILABLE"}'` (`RANDOM` para volver) |
| Broker caído sin perder eventos | `docker compose stop rabbitmq` → transferir (funciona) → `docker compose start rabbitmq` → la auditoría se pone al día sola |
| Doble clic / reintento | En "Nueva transferencia" el botón se bloquea en el primer clic; con curl, repetir la misma `Idempotency-Key` |
| Link de cobro | Dashboard de alice → "Cobrar con link" → abrir el enlace en otra ventana y pagar con bob |
| Movimientos en vivo | Dashboard de alice abierto (indicador "● En vivo"); en otra ventana privada bob le transfiere → el movimiento y el saldo aparecen solos |

## Despliegue (producción en una VM / EC2)

| Pieza | Qué hace |
|---|---|
| `docker-compose.prod.yml` | Override de producción: **solo Caddy** queda expuesto (80/443 con HTTPS automático); Postgres, RabbitMQ, los servicios y el riel quedan sin puertos públicos. JWT, Postgres y un usuario propio de RabbitMQ (no `guest`) son **obligatorios** por `.env`: si falta uno, compose no arranca. |
| `deploy/Caddyfile` | Reverse proxy hacia el frontend/gateway con certificado Let's Encrypt para `<ip>.sslip.io`; hace proxy también del WebSocket. |
| `deploy/bootstrap.sh` | En cualquier Ubuntu: 2 GB de swap, Docker, clona el repo, genera `.env` con secretos aleatorios (sin imprimirlos en el log) y levanta todo. Idempotente. |
| `deploy/aws-ec2.sh` | Crea el EC2 (Ubuntu 24.04 `t3.medium`, IMDSv2, security group con 22 solo desde tu IP) e inyecta `bootstrap.sh` como user-data. |

```bash
git push                                   # el EC2 clona el repo desde GitHub
AWS_PROFILE=personal ./deploy/aws-ec2.sh   # imprime la URL https://<ip>.sslip.io, el SSH y el comando para apagarlo
```

Para producción real faltaría: secretos en un gestor (SSM / Secrets Manager), contraseñas de los roles por servicio
parametrizadas (hoy viven en `db/init`, solo accesibles dentro de la red de compose), backups de Postgres y dominio propio.

## Arquitectura

```
                 ┌──────────────── frontend (React, nginx :8080) ─────────────────┐
                 │  /api/auth   /api/transfers|accounts|payment-links|ws   /api/audit │
                 ▼                          ▼  ▲ WebSocket                       ▼
          auth-service              payments-service ──outbox──▶ RabbitMQ ──▶ audit-service
          (auth_schema)             (payment_schema)   relay   payments.events  (audit_schema)
                                     │ worker    ▲                    │
                                     ▼           └── cola exclusiva ──┘ (avisos en tiempo real)
                              bank-rail-simulator
```

Cada servicio: `domain/` (entidades, máquina de estados, puertos; sin dependencias de framework) →
`application/` (casos de uso) → `infrastructure/` (Fastify, pg, amqplib, HTTP del riel) → `main.ts` (composition root).

## Decisiones de diseño y por qué

| Decisión | Por qué |
|---|---|
| **Node.js + TypeScript estricto, Fastify, `pg` con SQL explícito (sin ORM)** | Velocidad en 3 h y control total de transacciones: `SELECT … FOR UPDATE`, `ON CONFLICT`, `FOR UPDATE SKIP LOCKED` y UPDATE condicionales son el núcleo de la consistencia y un ORM los esconde. |
| **Hexagonal por servicio** | `domain/` y `application/` no importan Fastify, pg, amqplib ni `process.env`; BD, cola, riel, reloj e IDs son puertos. Por eso los casos de uso se prueban con fakes y el worker del riel con un riel falso. |
| **Dinero en `bigint` (centavos) y `NUMERIC(18,2)`** | Cero errores de punto flotante. La API usa strings decimales (`"100000.50"`); `pg` devuelve NUMERIC como string y nunca pasa por `number`. `CHECK (balance >= 0)` es la última red de seguridad. |
| **Idempotencia dentro de la misma transacción** | `INSERT … ON CONFLICT DO NOTHING` sobre la PK `(owner_id, key)` es lo primero que hace la transacción. Un reintento concurrente con la misma key **se bloquea en el índice único** hasta el commit del primero y luego reproduce la respuesta guardada (`Idempotent-Replayed: true`). No hace falta un lock distribuido ni un estado `IN_PROGRESS`. Si el payload difiere (hash SHA-256 de la huella canónica) → 422. Solo se guardan respuestas exitosas: un error de negocio hace rollback y el reintento se reevalúa. |
| **Bloqueo de cuentas en orden de id** | `lockByIds` ordena por id antes de `FOR UPDATE` → dos transferencias cruzadas A→B y B→A no hacen deadlock. Orden global de locks: idempotencia → transferencia → cuentas. |
| **Externas: retener el dinero y procesar el riel fuera de la transacción** | La creación debita y deja `PENDING` (202) en una TX corta; un worker reclama con lease (`FOR UPDATE SKIP LOCKED` + `next_attempt_at`) y llama al riel **sin transacción abierta** (puede tardar 10 s); el resultado se aplica en otra TX con UPDATE condicional. Escala a varias réplicas y sobrevive a caídas: si el proceso muere a mitad, el lease vence y se reintenta. |
| **Máquina de estados explícita** | `PENDING → COMPLETED/FAILED/UNKNOWN`, `UNKNOWN → COMPLETED/FAILED`, `COMPLETED → REVERSAL_PENDING → REVERSED/COMPLETED`. Validada en el dominio (`Transfer.transitionTo`) y en BD (`WHERE status = esperado`). |
| **Timeout ≠ fallo** | Sin respuesta en 10 s → `UNKNOWN` (dinero retenido), nunca `FAILED`. **Consultar antes de reenviar**: si un intento previo pudo llegar al banco se hace `GET /rail/transfers/{reference}` y solo se reenvía si el banco responde 404. La `reference` es el id de la transferencia (o del reverso) y nunca cambia. Tras N intentos queda `requiresManualReview` en vez de resolverse por suposición. |
| **Reverso "una sola vez"** | La fila de la transferencia se bloquea y la transición `COMPLETED → REVERSAL_PENDING` solo es válida una vez; con 5 reversos concurrentes exactamente uno gana (test REV-03). Interno: atómico; si el destino ya gastó el dinero → 422 y nada queda negativo. Externo: el reverso tiene su propia reference y su propia reconciliación. |
| **Transactional Outbox + publisher confirms + `mandatory`** | Cada cambio de estado inserta su evento en `payment_schema.outbox` en la misma TX. El relay marca `published_at` solo tras el confirm del broker. Con `mandatory: true`, si aún no existe la cola de auditoría el mensaje vuelve (`basic.return`) y se reintenta en lugar de perderse. At-least-once → el consumidor deduplica por `eventId`. |
| **Consumidor de auditoría idempotente** | `INSERT … ON CONFLICT (event_id) DO NOTHING`, ack manual después del commit, mensajes inválidos a DLQ, errores transitorios con requeue, reconexión automática. |
| **Un rol de PostgreSQL por servicio** | `payments_user` solo tiene privilegios en `payment_schema` (igual audit y auth). El aislamiento lo garantiza la BD, no una convención (test ARQ-01). Audit autoriza el historial con los `participantIds` que viajan en el evento, sin leer el esquema de pagos. |
| **JWT HS256 compartido + refresh tokens opacos rotados** | Simple de verificar en payments/audit sin llamar a auth. Refresh tokens hasheados en BD, rotación en una TX con `FOR UPDATE` y detección de reutilización (revoca todas las sesiones del usuario). Login con hash señuelo contra enumeración de usuarios por tiempo. |
| **Riel simulado propio** | Aleatorio por pesos, idempotente por `reference`, "verdad" consultable por GET y escenarios deterministas (palabras `OK/REJECT/DOWN/TIMEOUT/LOST` en el destino o `PUT /rail/admin/mode`) para demos y pruebas reproducibles. |
| **Movimientos en tiempo real por WebSocket** | `GET /ws?token=` en payments-service. Los avisos salen de los mismos eventos del outbox: cada instancia consume `payments.events` con una **cola exclusiva y autodelete** (fan-out), así escala a N réplicas y cada una avisa a sus clientes conectados, solo a los participantes. El aviso solo dice *qué transferencia cambió*; el cliente vuelve a consultar la API (fuente de verdad), también al reconectar. El JWT va en la query (el navegador no permite headers en WebSocket); token inválido o vencido → cierre `4401` y el cliente renueva y reconecta. nginx no registra esa ruta en el access log. |
| **Frontend sin doble envío** | Idempotency-Key generada al abrir el formulario y reutilizada en reintentos; botón bloqueado con un `ref` síncrono además del estado; polling cada 1,5 s hasta estado estable. |
| **Tests con PostgreSQL real (Testcontainers)** | La concurrencia (idempotencia, sobregiro, reversos) solo se puede probar contra la BD real. Cada test cita su criterio (`[IDEM-02] …`) y `scripts/trace.mjs` genera `docs/traceability.md` y falla si algún criterio queda sin test. |

## Pendiente / qué haría con una hora más

- **Auditar también los links de cobro** (creación/vencimiento). Hoy se audita el pago (es una transferencia) pero no la creación del link.
- **Plazo máximo para `PENDING`/`UNKNOWN`**: hoy reintenta con backoff y marca `requiresManualReview`; falta la regla de negocio (p. ej. a las 24 h, si el banco confirma 404, `FAILED` + reembolso) y una vista de operación para resolver los de revisión manual.
- **Limpieza**: retención de filas publicadas del outbox, TTL de idempotency keys y una herramienta para reprocesar la DLQ.
- **Observabilidad**: métricas (lag del outbox, transferencias `UNKNOWN`, intentos al riel), `correlationId` del request propagado en los eventos y trazas distribuidas.
- **Seguridad**: JWT asimétrico (RS256 + JWKS) para no compartir el secreto, refresh token en cookie `httpOnly` en lugar de `sessionStorage`, rate limiting / bloqueo en login.
- **Pruebas**: e2e automatizado contra `docker compose` (Playwright), contract test del evento payments→audit con un JSON Schema compartido y prueba de carga de concurrencia.
- **Despliegue**: construir las imágenes en CI (GitHub Actions → GHCR) para que la VM solo las descargue; así alcanza una instancia más pequeña y el despliegue no compila en producción.

## Supuestos

- El riel lo construimos nosotros (aclaración por correo durante la prueba). Su contrato está en `docs/spec.md` §9; el `GET /rail/transfers/{reference}` devuelve 404 si el banco nunca procesó la reference y también sirve para la reference de un reverso.
- Un error de conexión al riel (ECONNREFUSED / DNS) significa "no procesada" (como un 503); cualquier respuesta no reconocida o un corte a mitad de request es "desconocido" y se reconcilia.
- Auth necesita su propio esquema (`auth_schema`) además de `payment_schema` y `audit_schema`.
- Cada cuenta seed pertenece a un usuario seed (alice→ACC-001, bob→ACC-002, carol→ACC-003). Solo el dueño de la cuenta origen puede operar o reversar; el receptor de una interna puede consultarla.
- Las transferencias internas se crean y completan en la misma transacción (201); las externas responden 202 y se completan de forma asíncrona.
- La Idempotency-Key es por usuario (`owner_id, key`) y cubre crear transferencia y reversar. Solo se guardan respuestas 2xx.
- Moneda única COP con 2 decimales; montos hasta 16 dígitos enteros (`NUMERIC(18,2)`).
- Un reverso rechazado por el banco deja la transferencia `COMPLETED` y se puede volver a pedir.
- El historial de auditoría solo lo ven los participantes de la transferencia (dueños de las cuentas).

## Opcional: links de cobro (Payment Links)

Implementado después de cerrar el core (spec §11, criterios PL-01..06). alice crea un link de monto fijo hacia su cuenta,
comparte `http://localhost:8080/pay/{id}`, cualquiera lo ve sin login y otro usuario lo paga desde su cuenta. El pago
reutiliza **el mismo** `executeTransfer` del core (bloqueos, saldo, outbox) dentro de una transacción que además bloquea
el link (`FOR UPDATE`): un link se paga una sola vez aunque lleguen pagos concurrentes, y con la misma Idempotency-Key
el pago se reproduce. Vence a las 24 h (`EXPIRED` se deriva de `expiresAt`).

## Uso del agente (IA)

<!-- IA -->

**Cómo se trabajó.** Claude Code (Claude Opus) como agente principal y 4 subagentes en paralelo (auth, audit, riel
simulado, frontend). Cada uno recibió un brief cerrado: `CLAUDE.md` + criterios de `docs/spec.md` + `docs/openapi.yaml`
+ el contrato del evento, con prohibición de tocar archivos fuera de su carpeta y de hacer commits. El agente principal
escribió la spec, el contrato y el core de pagos, revisó el código de los subagentes y lo integró con `docker compose`.
Yo decidí el stack y el alcance, revisé cada cambio y ejecuté cada commit (trunk-based, rutas explícitas).

**Delegado al agente**
- Redacción de `CLAUDE.md`, `docs/spec.md` y `docs/openapi.yaml` a partir del PDF y de mis decisiones.
- Código y tests de payments-service (agente principal) y de auth, audit, riel simulado y frontend (subagentes).
- `docker-compose.yml`, `scripts/trace.mjs`, `scripts/test-all.sh` y este README.

**Hecho a mano / decidido por mí**
<!-- David: ajusta esta lista con lo que efectivamente escribiste o cambiaste tú. -->
- Elección de Node.js + TypeScript y de RabbitMQ; construir el riel simulado tras el correo de aclaración; hacer el opcional de Payment Links solo con el core cerrado.
- Revisión de cada diff antes de cada commit y la secuencia de commits pequeños.
- Repositorio, invitaciones y entrega.

**Errores del agente detectados y corregidos** (los encontraron los tests, la revisión o la prueba e2e)
1. **Healthchecks rotos en compose**: usó `wget http://localhost:PORT/health`; en `node:22-alpine` `localhost` resuelve a `::1` y el `wget` de busybox no reintenta por IPv4, así que todos los servicios quedaban `unhealthy`. Lo detectó el subagente de audit probando su imagen; se cambió a `127.0.0.1`.
2. **Bloqueo head-of-line en el worker del riel**: la primera versión procesaba un lote y no reclamaba más trabajo hasta terminarlo, así que una transferencia en timeout (10 s) frenaba a las demás. Apareció en la prueba e2e con `docker compose` (`EXT-DOWN-1` seguía con `attempts: 0`); se cambió por un pool de 8 workers que reclaman 1 transferencia cada uno, seguro gracias a `FOR UPDATE SKIP LOCKED` + lease.
3. **Test mal escrito**: para simular "conexión rechazada" usó el puerto 1, que `fetch` bloquea como *bad port* con otro error, y parecía un bug del adaptador. Se usa un puerto recién liberado (ECONNREFUSED real).
4. **Fórmula de conservación del dinero (EXT-08)** mal planteada en el primer borrador de la spec (excluía las externas `COMPLETED`); corregida antes del commit `spec: initial`.
5. **Riel simulado**: validación de monto con `regex().refine()` de zod; en zod 3 el `refine` corre aunque falle el regex, así que `BigInt("abc")` lanzaba y el riel respondía 500 en vez de 400. Corregido con una sola función de validación y un test.
6. **Consumidor de auditoría**: el primer reconnect esperaba `connection.close()` sobre un socket medio abierto, lo que podía colgar el loop de reconexión para siempre. Se programa el reintento primero y el `close` no se espera.
7. **Supuesto equivocado**: el PDF traía el riel como "[URL del repositorio]" y el agente asumió que lo entregarían; tras el correo de aclaración se construyó como servicio propio con su propio cambio de spec (`spec: riel bancario simulado propio…`).
8. **Test que no probaba nada (frontend)**: el primer test de PL-02 ("la consulta pública no envía el token") corría sin sesión iniciada, así que pasaba aunque el código enviara el token. Se agregó la variante con sesión, que sí detecta el error.
9. **Botón "Reversar" para quien no puede reversar**: el detalle lo mostraba también al receptor de la transferencia, y el backend (correctamente) solo deja reversar al dueño de la cuenta origen. Detectado al revisar las pantallas de Payment Links; ahora solo lo ve el dueño (test REV-01 del frontend).

**Resultado**: 196 tests (auth 23, payments 93, audit 23, riel 38, frontend 19) y los 59 criterios de la spec con al menos un test (`docs/traceability.md`).
