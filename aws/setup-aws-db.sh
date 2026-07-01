#!/usr/bin/env bash
# setup-aws-db.sh — Dựng Postgres trên EC2 host sẵn có để làm kho ý tưởng dùng chung.
# Làm: lấy IP/SG của instance → mở port 5432 CHỈ cho IP local của bạn → chạy Postgres
# (Docker) trên host → áp schema → in DATABASE_URL cho local & GitHub.
#
# Yêu cầu: AWS CLI đã cấu hình (aws configure), EC2 đang chạy + SSH được, file .pem, psql (tuỳ chọn).
# Chạy từ thư mục chứa file này (cùng chỗ với schema.sql):
#   INSTANCE_ID=i-0abc SSH_KEY=~/.ssh/key.pem ./setup-aws-db.sh
set -euo pipefail

# ============================ CONFIG ============================
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
INSTANCE_ID="${INSTANCE_ID:?Cần INSTANCE_ID của EC2 (vd i-0abc123)}"
SSH_KEY="${SSH_KEY:?Cần đường dẫn .pem (vd ~/.ssh/my-key.pem)}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"          # expand ~ → $HOME
SSH_USER="${SSH_USER:-ubuntu}"          # Amazon Linux dùng ec2-user
DB_NAME="${DB_NAME:-dailyloop}"
DB_USER="${DB_USER:-dailyloop}"
DB_PASS="${DB_PASS:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')}"   # random nếu không đặt
PG_PORT=5432
# ===============================================================

echo "→ [1/5] Lấy thông tin instance $INSTANCE_ID ($AWS_REGION)..."
read -r HOST SG_ID < <(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,SecurityGroups[0].GroupId]' --output text)
echo "   host=$HOST  security-group=$SG_ID"

echo "→ [2/5] Mở port $PG_PORT — CHỈ cho IP local của bạn (không mở ra cả Internet)..."
MY_IP="$(curl -fsS https://checkip.amazonaws.com)"
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
  --protocol tcp --port "$PG_PORT" --cidr "${MY_IP}/32" \
  --tag-specifications 'ResourceType=security-group-rule,Tags=[{Key=app,Value=dailyloop}]' \
  >/dev/null 2>&1 && echo "   ✓ cho phép ${MY_IP}/32" || echo "   (rule cho ${MY_IP}/32 đã tồn tại)"
# GitHub Actions: KHÔNG tự mở ở đây (dải IP rất rộng/đổi liên tục). Xem ghi chú cuối file.

echo "→ [3/5] Cài/chạy Postgres trên host qua Docker..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST" \
  "DB_NAME='$DB_NAME' DB_USER='$DB_USER' DB_PASS='$DB_PASS' bash -s" <<'REMOTE'
set -e
command -v docker >/dev/null 2>&1 || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER" || true; }
sudo docker volume create dailyloop_pg >/dev/null 2>&1 || true
if sudo docker ps -a --format '{{.Names}}' | grep -qx 'dailyloop-pg'; then
  echo "   container dailyloop-pg đã tồn tại"
else
  sudo docker run -d --name dailyloop-pg --restart unless-stopped \
    -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" \
    -p 5432:5432 -v dailyloop_pg:/var/lib/postgresql/data postgres:16 >/dev/null
  echo "   ✓ tạo container dailyloop-pg (postgres:16)"
fi
REMOTE

echo "→ [4/5] Áp schema (chờ Postgres sẵn sàng)..."
sleep 6
if command -v psql >/dev/null 2>&1; then
  PGPASSWORD="$DB_PASS" psql "host=$HOST port=$PG_PORT user=$DB_USER dbname=$DB_NAME sslmode=prefer" -f schema.sql
else
  echo "   (không có psql local → áp qua docker exec trên host)"
  ssh -i "$SSH_KEY" "$SSH_USER@$HOST" "sudo docker exec -i dailyloop-pg psql -U '$DB_USER' -d '$DB_NAME'" < schema.sql
fi
echo "   ✓ schema xong"

DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$HOST:$PG_PORT/$DB_NAME"
echo "$DATABASE_URL" > "$(dirname "$0")/DATABASE_URL.txt"   # để setup.sh đọc lại
echo "→ [5/5] Hoàn tất."
echo ""
echo "════════════════════════════════════════════════════════════"
echo " DATABASE_URL = $DATABASE_URL"
echo "════════════════════════════════════════════════════════════"
echo " • Local (.env):   DATABASE_URL=$DATABASE_URL"
echo " • GitHub secret:  gh secret set DATABASE_URL --body \"$DATABASE_URL\""
echo ""
echo " ⚠️  BẢO MẬT — đọc kỹ:"
echo "   - Script chỉ mở 5432 cho IP local của bạn ($MY_IP). KHÔNG bao giờ dùng 0.0.0.0/0."
echo "   - Kết nối hiện CHƯA mã hoá SSL. Để an toàn hơn, nên dùng Tailscale (xem ghi chú dưới)"
echo "     hoặc bật SSL cho Postgres rồi đổi sslmode=require."
echo ""
echo " 🔌 Cho GitHub Actions kết nối DB (3 cách, từ an toàn → kém an toàn):"
echo "   1. Self-hosted runner (trên Mac mini hoặc chính EC2) → IP cố định, chỉ allowlist IP đó."
echo "   2. Tailscale trong workflow (tailscale/github-action) → runner vào tailnet, DB không lộ public."
echo "   3. Allowlist dải IP GitHub Actions từ https://api.github.com/meta (rất rộng — ít khuyến khích)."
echo ""
echo " 🛡️  Khuyến nghị mạnh: thay vì mở port public, cài Tailscale trên EC2 + Mac mini + runner,"
echo "     rồi dùng DATABASE_URL trỏ tới IP tailnet (100.x.y.z). Không cần mở 5432 ra Internet."
