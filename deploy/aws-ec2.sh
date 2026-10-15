#!/usr/bin/env bash
# Crea un EC2 (Ubuntu 24.04) y despliega el portal usando deploy/bootstrap.sh como user-data.
#   AWS_PROFILE=personal ./deploy/aws-ec2.sh            (región por defecto us-east-1; AWS_REGION para cambiarla)
# Expone solo 80/443 (Caddy, HTTPS automático en https://<ip>.sslip.io) y SSH únicamente desde tu IP.
# El código se clona desde GitHub: haz push antes de correrlo.
set -euo pipefail
: "${AWS_PROFILE:?Define AWS_PROFILE con el perfil de TU cuenta (p. ej. AWS_PROFILE=personal)}"
REGION="${AWS_REGION:-us-east-1}"
NAME="${NAME:-portal-pagos}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"   # 2 vCPU / 4 GB: Postgres, RabbitMQ, 5 servicios y el build caben holgados
PUBLIC_KEY="${PUBLIC_KEY:-$HOME/.ssh/id_ed25519.pub}"
REPO_URL="${REPO_URL:-$(git remote get-url origin)}"
cd "$(dirname "$0")/.."
ec2() { aws --region "$REGION" --output text ec2 "$@"; }

echo "Cuenta: $(aws sts get-caller-identity --query Account --output text) · perfil $AWS_PROFILE · región $REGION"

# 1. Key pair: se IMPORTA tu llave pública; la privada nunca sale de tu máquina.
ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1 \
  || ec2 import-key-pair --key-name "$NAME" --public-key-material "fileb://$PUBLIC_KEY" >/dev/null

# 2. Security group en la VPC por defecto.
VPC_ID=$(ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId')
[ "$VPC_ID" != "None" ] || { echo "La región $REGION no tiene VPC por defecto"; exit 1; }
SG_ID=$(ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId')
if [ "$SG_ID" = "None" ]; then
  SG_ID=$(ec2 create-security-group --group-name "$NAME-sg" --vpc-id "$VPC_ID" \
    --description "portal-pagos: 80/443 publicos, 22 solo desde la IP del operador" --query GroupId)
  MY_IP=$(curl -sf https://checkip.amazonaws.com)
  ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
  ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
fi

# 3. AMI oficial de Ubuntu 24.04 publicada por Canonical en SSM.
AMI_ID=$(aws --region "$REGION" --output text ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value)

# 4. user-data = bootstrap con la URL del repo fijada.
USER_DATA=$(mktemp)
{ echo '#!/usr/bin/env bash'; echo "export REPO_URL='$REPO_URL'"; tail -n +2 deploy/bootstrap.sh; } > "$USER_DATA"

INSTANCE_ID=$(ec2 run-instances --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" --key-name "$NAME" \
  --security-group-ids "$SG_ID" --user-data "file://$USER_DATA" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
  --metadata-options 'HttpTokens=required' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId')
rm -f "$USER_DATA"
echo "Instancia $INSTANCE_ID creada; esperando que arranque…"
ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress')
URL="https://${IP//./-}.sslip.io"

echo "IP $IP. Instalando Docker y construyendo las imágenes (≈ 5-8 min)…"
for _ in $(seq 1 72); do
  curl -sf -o /dev/null --max-time 5 "$URL/" && break
  sleep 10
done
echo
echo "Portal:  $URL   (alice@demo.co / Demo1234!)"
echo "SSH:     ssh -i ${PUBLIC_KEY%.pub} ubuntu@$IP   (logs: sudo tail -f /var/log/cloud-init-output.log)"
echo "Apagar:  AWS_PROFILE=$AWS_PROFILE aws --region $REGION ec2 terminate-instances --instance-ids $INSTANCE_ID"
