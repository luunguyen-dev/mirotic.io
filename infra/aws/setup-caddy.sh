#!/usr/bin/env bash
# setup-aws-caddy.sh — Cài Caddy trên EC2 host + Caddyfile chuẩn cho multi-project.
# Mỗi project thêm 1 file riêng vào /etc/caddy/sites/<slug>.caddy → Caddy auto-import.
# Caddy tự lấy HTTPS cho mọi (sub)domain (nếu DNS đã trỏ về IP này).
#
# Yêu cầu trước: DNS *.mirotic.io (wildcard) đã trỏ về AWS_HOST.
# Chạy từ thư mục chứa file này:
#   AWS_HOST=... SSH_KEY=... SSH_USER=ec2-user ./setup-aws-caddy.sh
set -euo pipefail

AWS_HOST="${AWS_HOST:?cần AWS_HOST}"
SSH_KEY="${SSH_KEY:?cần SSH_KEY}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"
SSH_USER="${SSH_USER:-ec2-user}"

# Tự suy AWS_REGION từ INSTANCE_ID nếu có (để mở port 80+443 trong SG).
if [ -n "${INSTANCE_ID:-}" ] && [ -n "${AWS_REGION:-}" ]; then
  SG_ID="$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)"
  for PORT in 80 443; do
    aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
      --protocol tcp --port "$PORT" --cidr 0.0.0.0/0 >/dev/null 2>&1 \
      && echo "✓ SG mở port $PORT (0.0.0.0/0)" \
      || echo "   (port $PORT đã mở)"
  done
fi

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$AWS_HOST" 'bash -s' <<'REMOTE'
set -e
echo "→ Cài Caddy (Amazon Linux 2023)..."
if ! command -v caddy >/dev/null 2>&1; then
  sudo dnf install -y 'dnf-command(copr)' 2>/dev/null || true
  # Amazon Linux 2023 dùng dnf; Caddy có sẵn binary release.
  CADDY_VERSION="2.8.4"
  ARCH="$(uname -m)"
  case "$ARCH" in aarch64|arm64) AR="arm64";; x86_64) AR="amd64";; *) echo "arch $ARCH unsupported"; exit 1;; esac
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${AR}.tar.gz" -o /tmp/caddy.tgz
  sudo tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
  sudo chmod +x /usr/local/bin/caddy
fi

echo "→ Thư mục Caddy"
sudo mkdir -p /etc/caddy/sites /var/lib/caddy /var/log/caddy
sudo chown -R caddy:caddy /var/lib/caddy /var/log/caddy 2>/dev/null || {
  sudo groupadd --system caddy 2>/dev/null || true
  sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  sudo chown -R caddy:caddy /var/lib/caddy /var/log/caddy
}

echo "→ Caddyfile chuẩn"
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDYFILE'
{
  email luunguyen.dev@gmail.com
}
import sites/*.caddy
CADDYFILE

echo "→ systemd service"
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

# Cho phép caddy ssh bind port 80/443 (nếu chưa có CAP_NET_BIND_SERVICE)
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/caddy

echo "→ enable + start"
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 2
sudo systemctl is-active caddy && echo "✓ Caddy running" || { sudo journalctl -u caddy -n 30 --no-pager; exit 1; }

# Cho ec2-user quyền sửa /etc/caddy/sites + reload caddy (cho ship.sh)
echo "→ sudoers nopassword cho ec2-user (chỉ caddy reload + sites dir)"
sudo tee /etc/sudoers.d/caddy-deploy >/dev/null <<'SUDOERS'
ec2-user ALL=(ALL) NOPASSWD: /bin/tee /etc/caddy/sites/*, /usr/bin/systemctl reload caddy
SUDOERS
sudo chmod 0440 /etc/sudoers.d/caddy-deploy
REMOTE

echo ""
echo "════════════════════════════════════════════════════════════"
echo " Caddy đã chạy trên $AWS_HOST"
echo "════════════════════════════════════════════════════════════"
echo " ⚠️  PREREQ: DNS *.mirotic.io → $AWS_HOST (wildcard A record)"
echo " Test:    dig +short pi-1000-digits.mirotic.io"
echo " Site:    sau khi ship 1 project, https://<slug>.mirotic.io sẽ live."
