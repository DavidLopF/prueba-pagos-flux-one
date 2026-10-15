#!/usr/bin/env bash
# Corre los tests (unitarios + aceptación con Testcontainers) de todos los módulos y la trazabilidad spec → test.
# Requisitos: Node 22 y Docker en marcha.
set -euo pipefail
cd "$(dirname "$0")/.."

for module in services/auth-service services/payments-service services/audit-service services/bank-rail-simulator frontend; do
  echo "▶ ${module}"
  (cd "${module}" && npm ci --silent --no-audit --no-fund && npm test --silent)
done

echo "▶ trazabilidad spec → test"
node scripts/trace.mjs
