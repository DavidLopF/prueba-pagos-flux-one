# Especificación — Mini portal de pagos

Versión 1. Cada criterio tiene un ID estable. Los tests citan el ID en su nombre (`[TR-01] …`).
Contrato HTTP: `docs/openapi.yaml`. Reglas transversales: `CLAUDE.md`.

## 1. Contexto y glosario
- **Cuenta interna**: `ACC-xxx`, saldo en COP, pertenece a un usuario (`owner_id`).
- **Transferencia interna** (`INTERNAL`): entre dos cuentas internas, se liquida en una sola transacción de BD.
- **Transferencia externa** (`EXTERNAL`): desde una cuenta interna hacia una cuenta de otro banco, vía el **riel bancario**.
- **Idempotency-Key**: header que identifica un intento lógico del cliente; sus reintentos no repiten efectos.
- **Reference**: identificador enviado al riel; es el `id` de la transferencia (o del reverso) y no cambia entre reintentos.

### Datos iniciales
| Cuenta  | Saldo inicial | Dueño (usuario seed) |
|---------|--------------:|----------------------|
| ACC-001 | 1.000.000,00  | alice@demo.co        |
| ACC-002 |   500.000,00  | bob@demo.co          |
| ACC-003 |         0,00  | carol@demo.co        |
Contraseña de los usuarios seed: `Demo1234!`.

### Estados de una transferencia
```
             ┌────────── 422 ──────────► FAILED (reembolsada)
INTERNAL ──► COMPLETED
EXTERNAL ──► PENDING ── 200 ──► COMPLETED ── reverso ──► REVERSAL_PENDING ── ok ──► REVERSED
               │  ▲ 503 (reintenta)                           │ 422 rechazo
               │  │                                            └──────────► COMPLETED
               └── timeout ──► UNKNOWN ── GET /rail ──► COMPLETED | FAILED | (no existe → reenvía)
```
Estados terminales: `FAILED`, `REVERSED`. `COMPLETED` es terminal salvo por reverso.

### Respuestas del riel (contrato entregado)
| Respuesta            | Significado                                  | Acción del sistema |
|----------------------|----------------------------------------------|--------------------|
| 200 `ACCEPTED`       | Procesada                                    | `COMPLETED` |
| 422 `REJECTED`       | Rechazada                                    | `FAILED` + reembolso |
| 503                  | No disponible, **no** procesada              | Sigue `PENDING`, reintento con backoff, misma reference |
| Sin respuesta en 10s | Desconocido                                  | `UNKNOWN`, reconciliar con `GET /rail/transfers/{reference}` |

**Contrato complementario del riel** (el simulado lo construimos nosotros, ver §9):
- S1. `GET /rail/transfers/{reference}` responde `200 { "reference", "status": "ACCEPTED" | "REJECTED" }` si la conoce y `404` si no.
- S2. Un error de conexión (connection refused / DNS) antes de enviar el request equivale a 503 (no procesada).
- S3. Para reversos usamos la misma consulta `GET /rail/transfers/{reference}` con la reference del reverso.

---

## 2. Autenticación (AUTH)

**AUTH-01 Registro**
- Given un email no registrado y una contraseña de ≥ 8 caracteres
- When hago `POST /auth/register`
- Then recibo 201 con `{ id, email }` y la contraseña se guarda solo como hash bcrypt.
- And si el email ya existe recibo 409 `EMAIL_TAKEN`.

**AUTH-02 Login correcto**
- Given el usuario seed `alice@demo.co` con contraseña `Demo1234!`
- When hago `POST /auth/login`
- Then recibo 200 con `accessToken` (JWT, 15 min, `sub` = id de usuario) y `refreshToken`.

**AUTH-03 Login incorrecto**
- Given un email inexistente o una contraseña errónea
- When hago `POST /auth/login`
- Then recibo 401 `INVALID_CREDENTIALS` sin revelar cuál de los dos falló.

**AUTH-04 Endpoints protegidos**
- Given una petición a payments o audit sin `Authorization: Bearer`, con token vencido o con firma inválida
- When llamo cualquier endpoint distinto de `/health`
- Then recibo 401 `UNAUTHORIZED`.

**AUTH-05 Refresh con rotación**
- Given un `refreshToken` válido
- When hago `POST /auth/refresh`
- Then recibo un nuevo par de tokens y el refresh token anterior queda revocado
- And reutilizar el anterior devuelve 401.
- And `POST /auth/logout` revoca el refresh token actual.

**AUTH-06 Solo cuentas propias**
- Given alice autenticada (dueña de ACC-001)
- When intenta transferir desde ACC-002 o consultar el saldo de ACC-002
- Then recibe 403 `FORBIDDEN_ACCOUNT` y no hay movimiento de dinero.

---

## 3. Transferencias (TR)

**TR-01 Transferencia interna exitosa**
- Given ACC-001 con 1.000.000,00 y ACC-002 con 500.000,00
- When alice hace `POST /transfers` `{ type: INTERNAL, fromAccount: ACC-001, toAccount: ACC-002, amount: "100000.50" }` con una Idempotency-Key nueva
- Then recibe 201 con la transferencia en `COMPLETED`
- And ACC-001 queda en 899.999,50 y ACC-002 en 600.000,50, en la misma transacción de BD.

**TR-02 Monto inválido**
- Given cualquier cuenta con saldo
- When el `amount` es `"0"`, negativo, no numérico o vacío
- Then recibo 422 `INVALID_AMOUNT` y no se crea transferencia ni cambia ningún saldo.

**TR-03 Más de dos decimales**
- When el `amount` es `"10.001"`
- Then recibo 422 `INVALID_AMOUNT`.

**TR-04 Saldo insuficiente**
- Given ACC-003 con saldo 0,00
- When carol transfiere `"1.00"` desde ACC-003
- Then recibo 422 `INSUFFICIENT_FUNDS` y ningún saldo cambia (nunca hay saldo negativo).

**TR-05 Origen igual a destino**
- When `fromAccount` y `toAccount` son iguales
- Then recibo 422 `SAME_ACCOUNT`.

**TR-06 Cuenta inexistente**
- When `fromAccount` no existe, o es INTERNAL y `toAccount` no existe
- Then recibo 422 `ACCOUNT_NOT_FOUND` y no hay movimientos.

**TR-07 Idempotency-Key obligatoria**
- When hago `POST /transfers` o `POST /transfers/{id}/reversal` sin header `Idempotency-Key`
- Then recibo 400 `IDEMPOTENCY_KEY_REQUIRED`.

**TR-08 Consultar estado**
- Given una transferencia creada por alice
- When hace `GET /transfers/{id}`
- Then recibe 200 con `id, type, fromAccount, toAccount, amount, status, createdAt, updatedAt`
- And si la transferencia no existe o no es suya recibe 404.

**TR-09 Historial**
- When alice hace `GET /transfers?account=ACC-001`
- Then recibe sus transferencias (enviadas y recibidas por ACC-001) ordenadas por `createdAt` descendente.

**BAL-01 Consultar saldo**
- When alice hace `GET /accounts/ACC-001/balance`
- Then recibe 200 `{ accountId: "ACC-001", balance: "1000000.00", currency: "COP" }`.

---

## 4. Idempotencia (IDEM)

**IDEM-01 Reintento secuencial**
- Given una transferencia creada con la key `K1`
- When repito exactamente el mismo request con `K1`
- Then recibo el mismo status y cuerpo que la primera vez, con header `Idempotent-Replayed: true`
- And el origen se debitó una sola vez.

**IDEM-02 Reintentos concurrentes**
- Given ACC-001 con 1.000.000,00
- When envío 10 requests idénticos con la misma key `K2` al mismo tiempo
- Then existe exactamente una transferencia y un solo débito
- And las 10 respuestas tienen el mismo `id` de transferencia.

**IDEM-03 Misma key, payload distinto**
- Given una transferencia creada con la key `K3` por 100,00
- When envío `K3` con monto 200,00 (o con otro destino)
- Then recibo 422 `IDEMPOTENCY_KEY_REUSED` y no hay nuevos movimientos.

**IDEM-04 Alcance por usuario**
- Given alice usó la key `K4`
- When bob usa la misma key `K4` para su propia transferencia
- Then se procesa como una operación nueva (la key se aísla por usuario).

---

## 5. Transferencias externas y riel (EXT)

**EXT-01 Creación de externa**
- Given ACC-001 con saldo suficiente
- When alice crea una transferencia `EXTERNAL` a `EXT-BANCO-123` por 50.000,00
- Then recibe 202 con estado `PENDING` sin esperar al riel
- And los 50.000,00 se debitan (retienen) de ACC-001 en la misma transacción que crea la transferencia.

**EXT-02 Riel acepta (200)**
- Given una transferencia `PENDING`
- When el worker la envía al riel con `reference = id` y responde 200 `ACCEPTED`
- Then pasa a `COMPLETED` y el saldo retenido no vuelve a la cuenta.

**EXT-03 Riel rechaza (422)**
- Given una transferencia `PENDING`
- When el riel responde 422 `REJECTED`
- Then pasa a `FAILED` y el monto se reembolsa al origen en la misma transacción del cambio de estado.

**EXT-04 Riel no disponible (503)**
- Given una transferencia `PENDING`
- When el riel responde 503 (o hay error de conexión, supuesto S2)
- Then sigue `PENDING`, se incrementa `attempts`, se programa `nextAttemptAt` con backoff exponencial
- And el reintento usa la misma `reference` y no genera un segundo débito.

**EXT-05 Riel sin respuesta (timeout 10 s)**
- Given una transferencia `PENDING`
- When el riel no responde en 10 s
- Then pasa a `UNKNOWN` (nunca a `FAILED`) y el dinero sigue retenido.

**EXT-06 Reconciliación de UNKNOWN**
- Given una transferencia `UNKNOWN`
- When el worker consulta `GET /rail/transfers/{reference}`
- Then si el banco dice `ACCEPTED` pasa a `COMPLETED`
- And si dice `REJECTED` pasa a `FAILED` con reembolso
- And si responde 404 (no la recibió) se reenvía con la misma reference
- And si la consulta da 503/timeout se queda en `UNKNOWN` y se reintenta más tarde.

**EXT-07 Consultar antes de reenviar**
- Given una transferencia que ya fue enviada al menos una vez (`attempts > 0`)
- When el worker la vuelve a procesar (p. ej. tras una caída del servicio)
- Then primero consulta el estado en el riel y solo reenvía si el banco no la conoce.

**EXT-08 Conservación del dinero**
- Given cualquier combinación de respuestas del riel
- Then en todo momento `Σ saldos de cuentas + Σ montos de externas en PENDING/UNKNOWN/COMPLETED/REVERSAL_PENDING = Σ saldos iniciales`
  (las internas no cambian la suma; las externas `FAILED`/`REVERSED` ya fueron reembolsadas)
- And tras `N` intentos sin resolución la transferencia queda `UNKNOWN` con `requiresManualReview = true` (nunca se resuelve por suposición).

---

## 6. Reversos (REV)

**REV-01 Reverso de interna completada**
- Given una transferencia interna `COMPLETED` de ACC-001 a ACC-002 por 100.000,00
- When alice hace `POST /transfers/{id}/reversal` con una Idempotency-Key
- Then recibe 200 con la transferencia en `REVERSED`
- And ACC-002 se debita y ACC-001 se acredita por 100.000,00 en una sola transacción.

**REV-02 Solo transferencias completadas**
- Given una transferencia en `PENDING`, `UNKNOWN`, `FAILED` o `REVERSAL_PENDING`
- When se solicita su reverso
- Then se recibe 409 `INVALID_STATE` y nada cambia.

**REV-03 Una sola vez (también concurrente)**
- Given una transferencia `REVERSED` o con un reverso en curso
- When se solicita otro reverso con una key distinta (secuencial o simultáneamente)
- Then se recibe 409 `INVALID_STATE` y solo hay un reverso aplicado.

**REV-04 Destino sin fondos para el reverso interno**
- Given una interna `COMPLETED` cuyo destino ya gastó el dinero (saldo < monto)
- When se solicita el reverso
- Then se recibe 422 `INSUFFICIENT_FUNDS`, la transferencia sigue `COMPLETED` y ningún saldo queda negativo.

**REV-05 Reverso de externa**
- Given una externa `COMPLETED`
- When se solicita su reverso
- Then pasa a `REVERSAL_PENDING` (202) y el worker envía `POST /rail/reversals { reference: reversalId, originalReference: transferId, amount }`
- And con 200 pasa a `REVERSED` y el monto se acredita al origen
- And con 422 vuelve a `COMPLETED` (reverso rechazado, se puede volver a intentar)
- And con 503 sigue `REVERSAL_PENDING` y reintenta; con timeout se reconcilia como EXT-06 usando la reference del reverso.

**REV-06 Idempotencia del reverso**
- Given un reverso solicitado con la key `R1`
- When se repite con `R1`
- Then se recibe la misma respuesta con `Idempotent-Replayed: true` y no un 409.

---

## 7. Auditoría y mensajería (AUD)

**AUD-01 Evento por cada cambio de estado**
- Given cualquier creación o cambio de estado de una transferencia (`TRANSFER_CREATED`, `TRANSFER_COMPLETED`, `TRANSFER_FAILED`, `TRANSFER_UNKNOWN`, `TRANSFER_REVERSAL_REQUESTED`, `TRANSFER_REVERSED`, `TRANSFER_REVERSAL_REJECTED`)
- Then se inserta un evento en `payment_schema.outbox` **en la misma transacción** del cambio
- And si la transacción hace rollback, el evento no existe.

**AUD-02 Broker caído no bloquea ni pierde**
- Given RabbitMQ no disponible
- When alice crea una transferencia
- Then la transferencia se procesa normalmente (la petición no espera al broker)
- And los eventos quedan en el outbox con `publishedAt = null`
- And cuando el broker vuelve se publican y llegan a `audit_schema`.

**AUD-03 Publicación confiable**
- Then el relay marca `publishedAt` solo después del confirm del broker (at-least-once).

**AUD-04 Consumidor idempotente**
- Given un evento ya almacenado en `audit_schema.audit_events`
- When el mismo evento (mismo `eventId`) se entrega otra vez
- Then no se duplica y el mensaje se confirma (ack).

**AUD-05 Historial de auditoría**
- When alice hace `GET /audit/transfers/{id}/events` de una transferencia propia
- Then recibe los eventos ordenados por `occurredAt` ascendente con `eventType`, `status`, `occurredAt` y `payload`.

**AUD-06 Mensajes inválidos a la DLQ**
- Given un mensaje que no es JSON, no cumple el contrato del evento o tiene datos que PostgreSQL rechaza
- When el consumidor de auditoría lo recibe
- Then lo rechaza sin reencolar (`nack(requeue=false)`) y termina en `audit.transfer-events.dlq`
- And no bloquea los mensajes siguientes; un error transitorio (BD caída) sí se reencola.

---

## 8. Frontend (FE)

**FE-01 Sin doble envío**
- Given el formulario de nueva transferencia
- When el usuario hace doble clic en "Enviar"
- Then el botón se deshabilita en el primer clic y se envía con una Idempotency-Key generada al abrir el formulario
- And si la red falla y el usuario reintenta, se reutiliza la misma key (no se crea una segunda transferencia).

**FE-02 Estado casi en tiempo real**
- Given una transferencia recién creada
- When estoy en su detalle
- Then el estado se refresca por polling cada ~1,5 s hasta llegar a un estado estable (`COMPLETED`, `FAILED`, `REVERSED`).

**FE-03 Historial de auditoría**
- When abro el detalle de una transferencia
- Then veo la línea de tiempo de eventos de auditoría.

---

## 9. Riel bancario simulado (RAIL)

> Cambio comunicado por los evaluadores durante la prueba (correo 08:44): el servicio simulado del riel
> **lo construimos nosotros** (`services/bank-rail-simulator`). Los supuestos S1–S3 pasan a ser contrato.

Contrato (puerto 8080 en la red de compose, `http://localhost:8081` desde el host):

| Endpoint | Respuestas |
|----------|------------|
| `POST /rail/transfers` `{reference, from, to, amount}` | 200 `{reference, status: ACCEPTED}` · 422 `{reference, status: REJECTED, reason}` · 503 `{error: UNAVAILABLE}` · sin respuesta antes de 15 s · 400 body inválido · 409 `REFERENCE_CONFLICT` (misma reference con otro payload) |
| `GET /rail/transfers/{reference}` | 200 `{reference, kind: TRANSFER\|REVERSAL, status, amount}` · 404 `{error: NOT_FOUND}` · 503 / sin respuesta (con menor probabilidad) |
| `POST /rail/reversals` `{reference, originalReference, amount}` | Igual que transfers; 422 si la original no existe, no fue ACCEPTED, el monto no coincide o ya fue reversada |
| `PUT /rail/admin/mode` `{mode: RANDOM\|ACCEPT\|REJECT\|UNAVAILABLE\|TIMEOUT}` | Fuerza el resultado de todas las operaciones (para demos) |

**RAIL-01 Respuestas aleatorias**
- Given el riel en modo `RANDOM` con pesos configurables (por defecto 55 % ACCEPTED, 15 % REJECTED, 15 % 503, 15 % timeout)
- When recibe `POST /rail/transfers` o `POST /rail/reversals`
- Then responde 200, 422, 503 o no responde en 10 s según el sorteo
- And un body inválido (campos faltantes, monto con formato inválido o ≤ 0) responde 400 `BAD_REQUEST` sin procesar nada.

**RAIL-02 Idempotente por reference**
- Given una reference ya procesada (ACCEPTED o REJECTED)
- When llega otra vez con el mismo payload
- Then devuelve el resultado guardado sin volver a procesar ni sortear
- And si llega con otro payload responde 409 `REFERENCE_CONFLICT`.

**RAIL-03 Timeout con resultado incierto**
- Given un sorteo de timeout
- When el riel decide (50 %) si la operación quedó procesada o no
- Then `GET /rail/transfers/{reference}` refleja la verdad: 200 con estado si se procesó, 404 si no.

**RAIL-04 Reglas del reverso**
- When llega un reverso
- Then solo se acepta si la original existe, fue ACCEPTED, el monto coincide y no fue reversada antes.

**RAIL-05 Escenarios deterministas para demo**
- Given un `to` que contiene como **palabra completa** (separada por `-`, `_`, espacio…; sin distinguir mayúsculas)
  `OK`, `REJECT`, `DOWN`, `TIMEOUT` (procesada) o `LOST` (no procesada) — p. ej. `EXT-REJECT-1` —,
  o `REVOK` / `REVREJECT` / `REVDOWN` / `REVTIMEOUT` / `REVLOST` para el reverso de esa transferencia (p. ej. `EXT-OK-REVREJECT`)
- Or el modo forzado con `PUT /rail/admin/mode` (en modo forzado las consultas GET son veraces e inmediatas)
- Then el resultado es el indicado (precedencia: token > modo > azar).

---

## 10. Arquitectura verificable (ARQ)

**ARQ-01 Aislamiento de esquemas**
- Given el rol de base de datos de un servicio (p. ej. `payments_user`)
- When intenta leer otro esquema (`audit_schema`, `auth_schema`) o crear objetos en `public`
- Then PostgreSQL lo rechaza con `permission denied`: cada servicio accede solo a su esquema.

---

## 11. Opcional · Formularios de cobro (Payment Links, PL)

Un **payment link** es un cobro por un monto fijo hacia una cuenta del usuario que lo crea. Lo paga un tercero
(otro usuario del portal) desde una de sus cuentas; el pago es una **transferencia interna** con todas las reglas
de §3–§4 (idempotencia, saldo, auditoría). El link es de **un solo uso** y vence a las 24 h.
Estados: `ACTIVE → PAID`; `EXPIRED` se deriva de `expiresAt` (un link vencido nunca se paga).

**PL-01 Crear link**
- Given alice autenticada, dueña de ACC-001
- When hace `POST /payment-links` `{ accountId: ACC-001, amount: "25000.00", description: "Factura 123" }`
- Then recibe 201 con `{ id, accountId, amount, description, status: ACTIVE, expiresAt (= ahora + 24 h) }`
- And con un monto inválido recibe 422 `INVALID_AMOUNT`; con una cuenta ajena 403 `FORBIDDEN_ACCOUNT`; con descripción vacía o > 140 caracteres 400.

**PL-02 Ver link (público)**
- Given un link existente
- When cualquiera (sin token) hace `GET /payment-links/{id}/public`
- Then recibe 200 con `{ id, accountId, amount, currency, description, status, expiresAt }` (sin datos del dueño)
- And si no existe recibe 404.

**PL-03 Pagar link**
- Given el link ACTIVE de alice por 25.000,00 y bob con saldo en ACC-002
- When bob hace `POST /payment-links/{id}/pay` `{ fromAccount: ACC-002 }` con Idempotency-Key
- Then recibe 201 con una transferencia INTERNAL ACC-002 → ACC-001 en `COMPLETED`
- And el link queda `PAID` con `paidTransferId`, en la **misma transacción** que el débito/crédito y los eventos de auditoría.

**PL-04 Un solo uso**
- Given un link ya pagado (o dos pagos concurrentes con keys distintas)
- When se intenta pagar otra vez
- Then solo un pago se aplica y los demás reciben 409 `INVALID_STATE`
- And repetir el pago con la misma Idempotency-Key reproduce la respuesta original (`Idempotent-Replayed: true`).

**PL-05 Reglas del pago**
- Given un link vencido → 422 `PAYMENT_LINK_EXPIRED`
- Given un pagador sin saldo suficiente → 422 `INSUFFICIENT_FUNDS` y el link sigue `ACTIVE`
- Given un pagador que usa una cuenta ajena → 403 `FORBIDDEN_ACCOUNT`; pagar hacia la misma cuenta del link → 422 `SAME_ACCOUNT`.

**PL-06 Mis links**
- When alice hace `GET /payment-links?account=ACC-001`
- Then recibe sus links ordenados por `createdAt` descendente con su estado actual (incluido `EXPIRED`).
