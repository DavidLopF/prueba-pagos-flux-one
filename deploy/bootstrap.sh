#!/usr/bin/env bash
# Prepara una VM Ubuntu (24.04) y levanta el portal en producción. Se usa como user-data de EC2 o a mano:
#   curl -fsSL <raw>/deploy/bootstrap.sh | sudo REPO_URL=<repo> bash
# Idempotente: si se vuelve a correr, actualiza el código y conserva el .env (secretos) existente.
set -euxo pipefail

REPO_URL="${REPO_URL:-https://github.com/DavidLopF/prueba-pagos-flux-one.git}"
APP_DIR="${APP_DIR:-/opt/portal-pagos}"
export DEBIAN_FRONTEND=noninteractive

# 2 GB de swap: el build de las 5 imágenes (npm ci + tsc + vite) no debe quedarse sin memoria en una VM chica.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v git >/dev/null || apt-get install -y git

if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  # IP pública: metadata de EC2 (IMDSv2) o, fuera de AWS, un servicio externo.
  IMDS_TOKEN=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" http://169.254.169.254/latest/meta-data/public-ipv4 \
    || curl -sf https://checkip.amazonaws.com)
  umask 077
  set +x # no imprimir los secretos en el log de cloud-init
  cat > .env <<ENV
# Generado por deploy/bootstrap.sh — NO se sube al repositorio.
DOMAIN=${PUBLIC_IP//./-}.sslip.io
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
RABBITMQ_USER=portal
RABBITMQ_PASSWORD=$(openssl rand -hex 24)
ENV
  set -x
fi

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
echo "Portal en https://$(grep '^DOMAIN=' .env | cut -d= -f2)"
