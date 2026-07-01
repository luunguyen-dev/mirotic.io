#!/usr/bin/env bash
# setup-aws-dashboard.sh — Deploy dashboard (mode=serve) lên EC2, public qua Caddy
# tại mirotic.luunguyen.dev. Chạy:
#   AWS_HOST=... SSH_KEY=... SSH_USER=ec2-user ./setup-aws-dashboard.sh
# Yêu cầu: Caddy đã cài (chạy setup-aws-caddy.sh trước), DNS mirotic.luunguyen.dev → AWS_HOST.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

AWS_HOST="${AWS_HOST:?cần AWS_HOST}"
SSH_KEY="${SSH_KEY:?cần SSH_KEY}"; SSH_KEY="${SSH_KEY/#\~/$HOME}"
SSH_USER="${SSH_USER:-ec2-user}"
SSH_CMD=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$AWS_HOST")

echo "→ [1/4] Build .env.dashboard (chỉ vars dashboard cần)"
ENV_FILE=/tmp/.env.dashboard.$$
{
  echo "PORT=4321"
  echo "BASE_URL=https://mirotic.luunguyen.dev"
  echo "DATABASE_URL=postgresql://$(grep ^DB_USER= "$ROOT/.env" | cut -d= -f2-):$(grep ^DB_PASS= "$ROOT/.env" | cut -d= -f2- | sed 's/@/%40/g')@localhost:5432/$(grep ^DB_NAME= "$ROOT/.env" | cut -d= -f2-)"
  echo "HMAC_SECRET=$(grep ^HMAC_SECRET= "$ROOT/.env" | cut -d= -f2-)"
  echo "USE_REAL_CLAUDE=false"
  echo "USE_REAL_OLLAMA=false"
} > "$ENV_FILE"

echo "→ [2/4] rsync source → /opt/mirotic-dashboard/"
"${SSH_CMD[@]}" "sudo mkdir -p /opt/mirotic-dashboard && sudo chown $SSH_USER:$SSH_USER /opt/mirotic-dashboard"
rsync -az --delete \
  --exclude='.git' --exclude='data' --exclude='node_modules' --exclude='.env' \
  --exclude='*.pem' --exclude='templates' --exclude='aws' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "$SSH_USER@$AWS_HOST:/opt/mirotic-dashboard/"
scp -i "$SSH_KEY" "$ROOT/aws/dashboard.compose.yml" "$SSH_USER@$AWS_HOST:/opt/mirotic-dashboard/docker-compose.yml"
scp -i "$SSH_KEY" "$ENV_FILE" "$SSH_USER@$AWS_HOST:/opt/mirotic-dashboard/.env.dashboard"
rm -f "$ENV_FILE"

echo "→ [3/4] docker compose up"
"${SSH_CMD[@]}" "cd /opt/mirotic-dashboard && sudo docker compose down 2>/dev/null || true && sudo docker compose up -d --build"

echo "→ [4/4] Caddy block mirotic.luunguyen.dev"
"${SSH_CMD[@]}" 'sudo tee /etc/caddy/sites/dashboard.caddy >/dev/null <<'"'"'EOF'"'"'
mirotic.luunguyen.dev {
  reverse_proxy localhost:4321
}
EOF
sudo systemctl reload caddy'

echo ""
echo "✓ Dashboard live: https://mirotic.luunguyen.dev"
echo "  (chờ vài giây cho Caddy lấy cert lần đầu)"
