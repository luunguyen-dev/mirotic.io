#!/usr/bin/env bash
# setup-mobile-apps.sh — one-time setup trên EC2:
#   1. Tạo /var/www/mirotic-apps/ (chứa <slug>/app.apk per idea)
#   2. Đảm bảo /etc/caddy/vhosts/ tồn tại (per-idea Caddyfile block)
#   3. Import glob vào Caddyfile main để load các block đó
#
# Idempotent — chạy nhiều lần OK. Ship-mobile.sh (mỗi lần deploy 1 mobile app)
# sẽ append vhost block vào /etc/caddy/vhosts/<slug>.caddy và reload.
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# eval để interpret ~ như $HOME đúng theo cách shell expand.
eval "$(grep -E "^(AWS_HOST|SSH_KEY|SSH_USER)=" "$ROOT/.env" | sed "s|~|$HOME|g")"
SSH_CMD=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$AWS_HOST")

echo "→ [1/3] Tạo /var/www/mirotic-apps/ trên EC2"
"${SSH_CMD[@]}" bash <<'EOF'
sudo mkdir -p /var/www/mirotic-apps
sudo chown $USER:$USER /var/www/mirotic-apps
sudo chmod 755 /var/www/mirotic-apps
sudo mkdir -p /etc/caddy/vhosts
sudo chown $USER:$USER /etc/caddy/vhosts
EOF

echo "→ [2/3] Đảm bảo Caddyfile main import /etc/caddy/vhosts/*.caddy"
"${SSH_CMD[@]}" bash <<'EOF'
CADDYFILE=/etc/caddy/Caddyfile
if [[ -f "$CADDYFILE" ]] && ! sudo grep -q "import /etc/caddy/vhosts/\*.caddy" "$CADDYFILE"; then
  echo "" | sudo tee -a "$CADDYFILE" > /dev/null
  echo "# mirotic mobile app vhosts (auto-managed by ship-mobile.sh)" | sudo tee -a "$CADDYFILE" > /dev/null
  echo "import /etc/caddy/vhosts/*.caddy" | sudo tee -a "$CADDYFILE" > /dev/null
  echo "  → thêm import /etc/caddy/vhosts/*.caddy vào $CADDYFILE"
else
  echo "  → import đã có, skip"
fi
sudo systemctl reload caddy || sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile || true
EOF

echo "→ [3/3] Verify"
"${SSH_CMD[@]}" bash <<'EOF'
ls -la /var/www/mirotic-apps/ /etc/caddy/vhosts/
EOF

echo ""
echo "✓ Setup xong. Từ giờ mỗi lần deploy mobile app:"
echo "  - ship-mobile.sh sẽ scp APK lên /var/www/mirotic-apps/<slug>/app.apk"
echo "  - Và append /etc/caddy/vhosts/<slug>.caddy để expose <slug>.luunguyen.dev/app.apk"
