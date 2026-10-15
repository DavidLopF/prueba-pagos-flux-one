# Trazabilidad spec → tests

Generado por `node scripts/trace.mjs`. No editar a mano.

Criterios: 55 · cubiertos: 55 · sin test: 0

| Criterio | Descripción | Tests | Archivos |
|----------|-------------|------:|----------|
| AUTH-01 | Registro | 6 | `services/auth-service/test/acceptance/auth.acceptance.test.ts`<br>`services/auth-service/test/unit/register-user.test.ts` |
| AUTH-02 | Login correcto | 6 | `services/auth-service/test/acceptance/auth.acceptance.test.ts`<br>`services/auth-service/test/unit/jwt-access-tokens.test.ts`<br>`services/auth-service/test/unit/login.test.ts` |
| AUTH-03 | Login incorrecto | 3 | `services/auth-service/test/acceptance/auth.acceptance.test.ts`<br>`services/auth-service/test/unit/login.test.ts` |
| AUTH-04 | Endpoints protegidos | 4 | `services/audit-service/test/acceptance/audit-service.test.ts`<br>`services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| AUTH-05 | Refresh con rotación | 8 | `services/auth-service/test/acceptance/auth.acceptance.test.ts`<br>`services/auth-service/test/unit/logout.test.ts`<br>`services/auth-service/test/unit/refresh-session.test.ts` |
| AUTH-06 | Solo cuentas propias | 2 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts`<br>`services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| TR-01 | Transferencia interna exitosa | 2 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts`<br>`services/payments-service/test/unit/money.test.ts` |
| TR-02 | Monto inválido | 4 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts`<br>`services/payments-service/test/unit/money.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| TR-03 | Más de dos decimales | 2 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts`<br>`services/payments-service/test/unit/money.test.ts` |
| TR-04 | Saldo insuficiente | 4 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts`<br>`services/payments-service/test/unit/money.test.ts` |
| TR-05 | Origen igual a destino | 2 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| TR-06 | Cuenta inexistente | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| TR-07 | Idempotency-Key obligatoria | 2 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| TR-08 | Consultar estado | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| TR-09 | Historial | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| BAL-01 | Consultar saldo | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| IDEM-01 | Reintento secuencial | 2 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| IDEM-02 | Reintentos concurrentes | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| IDEM-03 | Misma key, payload distinto | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| IDEM-04 | Alcance por usuario | 1 | `services/payments-service/test/acceptance/transfers.acceptance.test.ts` |
| EXT-01 | Creación de externa | 2 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| EXT-02 | Riel acepta (200) | 2 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/http-bank-rail.test.ts` |
| EXT-03 | Riel rechaza (422) | 3 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/http-bank-rail.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| EXT-04 | Riel no disponible (503) | 3 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/http-bank-rail.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| EXT-05 | Riel sin respuesta (timeout 10 s) | 3 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/http-bank-rail.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| EXT-06 | Reconciliación de UNKNOWN | 4 | `services/payments-service/test/acceptance/rail.acceptance.test.ts`<br>`services/payments-service/test/unit/http-bank-rail.test.ts` |
| EXT-07 | Consultar antes de reenviar | 2 | `services/payments-service/test/acceptance/rail.acceptance.test.ts` |
| EXT-08 | Conservación del dinero | 2 | `services/payments-service/test/acceptance/rail.acceptance.test.ts` |
| REV-01 | Reverso de interna completada | 2 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts`<br>`frontend/test/transfer-detail.test.tsx` |
| REV-02 | Solo transferencias completadas | 2 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| REV-03 | Una sola vez (también concurrente) | 2 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| REV-04 | Destino sin fondos para el reverso interno | 1 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts` |
| REV-05 | Reverso de externa | 4 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| REV-06 | Idempotencia del reverso | 1 | `services/payments-service/test/acceptance/reversals.acceptance.test.ts` |
| AUD-01 | Evento por cada cambio de estado | 3 | `services/payments-service/test/acceptance/outbox.acceptance.test.ts`<br>`services/payments-service/test/unit/transfer.test.ts` |
| AUD-02 | Broker caído no bloquea ni pierde | 2 | `services/audit-service/test/acceptance/rabbitmq-audit-consumer.test.ts`<br>`services/payments-service/test/acceptance/outbox.acceptance.test.ts` |
| AUD-03 | Publicación confiable | 1 | `services/payments-service/test/acceptance/outbox.acceptance.test.ts` |
| AUD-04 | Consumidor idempotente | 8 | `services/audit-service/test/acceptance/audit-service.test.ts`<br>`services/audit-service/test/acceptance/rabbitmq-audit-consumer.test.ts`<br>`services/audit-service/test/unit/audit-event.test.ts`<br>`services/audit-service/test/unit/audit-message-handler.test.ts`<br>`services/audit-service/test/unit/record-audit-event.test.ts` |
| AUD-05 | Historial de auditoría | 5 | `services/audit-service/test/acceptance/audit-service.test.ts`<br>`services/audit-service/test/unit/get-transfer-audit-history.test.ts` |
| AUD-06 | Mensajes inválidos a la DLQ | 5 | `services/audit-service/test/acceptance/audit-service.test.ts`<br>`services/audit-service/test/acceptance/rabbitmq-audit-consumer.test.ts`<br>`services/audit-service/test/unit/audit-event.test.ts`<br>`services/audit-service/test/unit/audit-message-handler.test.ts`<br>`services/audit-service/test/unit/record-audit-event.test.ts` |
| FE-01 | Sin doble envío | 3 | `frontend/test/transfer-form.test.tsx` |
| FE-02 | Estado casi en tiempo real | 1 | `frontend/test/transfer-detail.test.tsx` |
| FE-03 | Historial de auditoría | 1 | `frontend/test/transfer-detail.test.tsx` |
| RAIL-01 | Respuestas aleatorias | 8 | `services/bank-rail-simulator/test/app.test.ts`<br>`services/bank-rail-simulator/test/rail.test.ts` |
| RAIL-02 | Idempotente por reference | 4 | `services/bank-rail-simulator/test/app.test.ts`<br>`services/bank-rail-simulator/test/rail.test.ts` |
| RAIL-03 | Timeout con resultado incierto | 3 | `services/bank-rail-simulator/test/app.test.ts`<br>`services/bank-rail-simulator/test/rail.test.ts` |
| RAIL-04 | Reglas del reverso | 5 | `services/bank-rail-simulator/test/app.test.ts`<br>`services/bank-rail-simulator/test/rail.test.ts` |
| RAIL-05 | Escenarios deterministas para demo | 7 | `services/bank-rail-simulator/test/app.test.ts`<br>`services/bank-rail-simulator/test/rail.test.ts` |
| ARQ-01 | Aislamiento de esquemas | 2 | `services/audit-service/test/acceptance/audit-service.test.ts`<br>`services/payments-service/test/acceptance/schema-isolation.acceptance.test.ts` |
| PL-01 | Crear link | 4 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`services/payments-service/test/unit/payment-link.test.ts`<br>`frontend/test/payment-links.test.tsx` |
| PL-02 | Ver link (público) | 3 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`frontend/test/payment-links.test.tsx` |
| PL-03 | Pagar link | 2 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`frontend/test/payment-links.test.tsx` |
| PL-04 | Un solo uso | 6 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`services/payments-service/test/unit/payment-link.test.ts`<br>`frontend/test/payment-links.test.tsx` |
| PL-05 | Reglas del pago | 3 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`services/payments-service/test/unit/payment-link.test.ts`<br>`frontend/test/payment-links.test.tsx` |
| PL-06 | Mis links | 2 | `services/payments-service/test/acceptance/payment-links.acceptance.test.ts`<br>`frontend/test/payment-links.test.tsx` |
