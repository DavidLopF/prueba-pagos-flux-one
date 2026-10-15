# Reglas del proyecto — Mini portal de pagos (SDD)

Este archivo es la fuente de reglas para cualquier agente (Claude Code, Codex, Cursor…) y para humanos.
`AGENTS.md` apunta aquí. Si una regla de este archivo choca con una petición puntual, gana este archivo
salvo que el humano la cambie explícitamente aquí.

## 0. Flujo Spec-Driven Development
1. **La spec manda.** Toda funcionalidad nace como criterio Given/When/Then en `docs/spec.md` con un ID
   (`TR-01`, `IDEM-02`, …). El contrato HTTP vive en `docs/openapi.yaml`.
2. Orden obligatorio: spec → contrato → test que referencia el ID → implementación.
3. Si el código necesita algo que la spec no dice, **primero se actualiza la spec** (y el contrato), luego el código.
4. Cada test empieza su nombre con el ID del criterio que cubre: `it('[IDEM-02] …')`.
   `node scripts/trace.mjs` debe pasar (ningún criterio sin test, ningún test con ID inexistente).
5. Commits pequeños, trunk-based, Conventional Commits (`spec:`, `feat(payments):`, `test(audit):`, `chore:`…).

## 1. Arquitectura (hexagonal, por microservicio)
```
services/<svc>/src/
  domain/          entidades, value objects, máquina de estados, errores, puertos (interfaces)
  application/     casos de uso; solo dependen de puertos del dominio
  infrastructure/  adaptadores: http (Fastify), persistence (pg), rail (HTTP), messaging (RabbitMQ)
  main.ts          composition root: el único lugar que conoce todos los adaptadores
```
- `domain/` y `application/` **no importan** `fastify`, `pg`, `amqplib`, `jsonwebtoken`, `process.env` ni nada de I/O.
- Base de datos, cola, riel bancario, reloj y generador de IDs son **puertos** con adaptadores.
- Tres servicios: `auth-service`, `payments-service`, `audit-service`. No comparten código de dominio ni BD.
- **Aislamiento de esquemas**: cada servicio se conecta con su propio rol de PostgreSQL que solo tiene permisos
  en su esquema (`auth_schema`, `payment_schema`, `audit_schema`). Nunca un JOIN ni consulta entre esquemas.
- La comunicación Payments → Audit es **solo** por eventos en RabbitMQ.

## 2. Dinero
- Moneda única: **COP con hasta 2 decimales**.
- En la API los montos viajan como **string decimal** (`"150000.50"`), nunca como `number` JSON.
- En el dominio se representan como `bigint` en **centavos** (`Money`). Prohibido `number`/`parseFloat` para dinero.
- En la BD: `NUMERIC(18,2)` y `CHECK (balance >= 0)` en cuentas.
- Monto válido: `> 0` y como máximo 2 decimales. Nunca saldo negativo.
- Todo movimiento de saldo ocurre dentro de una transacción de BD, bloqueando las cuentas con
  `SELECT … FOR UPDATE` **en orden de id ascendente** (evita deadlocks).
- El dinero siempre está en exactamente un lugar: en una cuenta, retenido por una transferencia
  `PENDING/UNKNOWN`, o entregado al riel (`COMPLETED`). Nunca se "pierde" por un fallo.

## 3. Idempotencia
- Todo `POST` que mueve dinero exige header `Idempotency-Key` (400 si falta).
- Alcance de la key: `(owner_id, key)`. Se guarda el hash SHA-256 del payload canónico.
- La fila de idempotencia se inserta con `INSERT … ON CONFLICT DO NOTHING` **en la misma transacción** que la
  operación de negocio y la respuesta se guarda antes del commit. Así una petición concurrente con la misma key
  espera el lock del índice único y luego **reproduce** la respuesta guardada (header `Idempotent-Replayed: true`).
- Misma key con payload distinto → **422** `IDEMPOTENCY_KEY_REUSED`.
- Hacia el riel la idempotencia es la `reference` (= id de la transferencia/reverso), estable en todos los reintentos.
- **Consultar antes de reenviar**: si una operación ya fue enviada al riel y el resultado es desconocido,
  primero `GET /rail/transfers/{reference}`; solo se reenvía si el banco no la conoce.

## 4. Máquina de estados de transferencias
`PENDING → COMPLETED | FAILED | UNKNOWN`, `UNKNOWN → COMPLETED | FAILED`,
`COMPLETED → REVERSAL_PENDING → REVERSED | COMPLETED`.
- Las transiciones se validan en el dominio (`Transfer.transitionTo`) y en BD con UPDATE condicional
  (`WHERE status = <esperado>`); 0 filas afectadas = conflicto (409).
- Un timeout del riel **nunca** se convierte en `FAILED`: se convierte en `UNKNOWN` y se reconcilia.

## 5. Eventos y auditoría
- Cada cambio de estado escribe un evento en `payment_schema.outbox` **en la misma transacción** (Transactional Outbox).
- Un relay publica a RabbitMQ con publisher confirms y marca `published_at`. Entrega at-least-once.
- El consumidor de auditoría es idempotente (`UNIQUE(event_id)` + `ON CONFLICT DO NOTHING`) y hace ack manual.

## 6. Seguridad
- JWT HS256 (access 15 min) emitido por `auth-service`; payments/audit lo validan con el secreto compartido.
- Un usuario solo opera y consulta cuentas cuyo `owner_id` es su `sub` (403 si no).
- Contraseñas con bcrypt. Refresh tokens opacos, guardados hasheados y rotados en cada uso.
- Nunca loguear contraseñas, tokens ni payloads completos con datos sensibles.

## 7. Errores HTTP
`400` validación de forma / falta Idempotency-Key · `401` sin token o token inválido · `403` cuenta ajena ·
`404` recurso inexistente · `409` transición de estado inválida · `422` regla de negocio
(saldo insuficiente, monto inválido, key reutilizada con otro payload). Cuerpo: `{ "code": "...", "message": "..." }`.

## 8. Convenciones de código
- TypeScript estricto, Node 22, ESM. SQL explícito con `pg` (sin ORM).
- Tests con Vitest: unitarios con fakes de puertos; aceptación con PostgreSQL real (Testcontainers).
- El riel bancario simulado es un servicio propio (`services/bank-rail-simulator`, contrato en `docs/spec.md` §9).
  payments-service solo lo consume vía `RAIL_BASE_URL` y no asume nada fuera de ese contrato.
