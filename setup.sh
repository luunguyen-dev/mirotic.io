#!/usr/bin/env bash
# setup.sh — Dựng toàn bộ hệ thống từ đầu đến cuối. Chạy trên Mac mini.
#   1) Đọc .env  2) Kiểm tra công cụ  3) Dựng Postgres trên AWS  4) Ollama + model
#   5) Kiểm tra GitHub/Claude  6) Build & chạy Docker  7) Smoke test
# Trước khi chạy: copy .env.example → .env và điền (xem SETUP.md cho cách lấy từng giá trị).
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "   \033[32m✓\033[0m %s\n" "$1"; }
die()  { printf "\033[31m❌ %s\033[0m\n" "$1"; exit 1; }

# Đọc 1 biến từ .env mà KHÔNG source (an toàn với giá trị có dấu cách).
# Strip trailing inline comment ("  # ...") và whitespace 2 đầu — nếu không
# docker compose env_file v2 sẽ nuốt cả comment làm giá trị.
getenv() {
  local raw
  raw="$(grep -E "^$1=" .env 2>/dev/null | head -1)" || true
  [ -z "$raw" ] && return 0
  printf '%s' "${raw#*=}" | sed -E 's/[[:space:]]+#.*$//' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}
# Ghi/đổi 1 biến trong .env
upsert() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then sed -i.bak "s|^${k}=.*|${k}=${v}|" .env && rm -f .env.bak
  else echo "${k}=${v}" >> .env; fi
}

# ---------- 0. .env ----------
bold "[0/7] Đọc .env"
[ -f .env ] || die "Chưa có .env. Chạy: cp .env.example .env  rồi điền (xem SETUP.md)."
ok ".env tồn tại"

# ---------- 1. Biến bắt buộc ----------
bold "[1/7] Kiểm tra biến bắt buộc"
REQUIRED=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION INSTANCE_ID SSH_KEY GITHUB_TOKEN GITHUB_OWNER)
missing=()
for k in "${REQUIRED[@]}"; do [ -n "$(getenv "$k")" ] || missing+=("$k"); done
[ ${#missing[@]} -eq 0 ] || die "Thiếu trong .env: ${missing[*]}  → xem SETUP.md để lấy từng giá trị."
ok "đủ ${#REQUIRED[@]} biến bắt buộc"

# ---------- 2. Công cụ ----------
bold "[2/7] Kiểm tra công cụ trên máy"
for t in docker aws ssh curl openssl; do command -v "$t" >/dev/null 2>&1 || die "Thiếu '$t' — xem SETUP.md mục 'Công cụ cần cài'."; done
docker info >/dev/null 2>&1 || die "Docker chưa chạy — mở Docker Desktop rồi chạy lại."
ok "docker, aws, ssh, curl, openssl sẵn sàng"

# HMAC_SECRET: tự sinh nếu trống/placeholder
HMAC="$(getenv HMAC_SECRET)"
if [ -z "$HMAC" ] || [ "$HMAC" = "change-me-please" ]; then upsert HMAC_SECRET "$(openssl rand -hex 32)"; ok "đã sinh HMAC_SECRET ngẫu nhiên"; fi

# ---------- 3. AWS Postgres ----------
bold "[3/7] Postgres trên AWS"
export AWS_ACCESS_KEY_ID="$(getenv AWS_ACCESS_KEY_ID)"
export AWS_SECRET_ACCESS_KEY="$(getenv AWS_SECRET_ACCESS_KEY)"
export AWS_DEFAULT_REGION="$(getenv AWS_REGION)"
if [ -n "$(getenv DATABASE_URL)" ]; then
  ok "DATABASE_URL đã có trong .env — bỏ qua provisioning"
else
  _IID="$(getenv INSTANCE_ID)"; _KEY="$(getenv SSH_KEY)"; _USER="$(getenv SSH_USER)"
  _DBN="$(getenv DB_NAME)"; _DBU="$(getenv DB_USER)"; _DBP="$(getenv DB_PASS)"; _REG="$(getenv AWS_REGION)"
  ( cd aws && AWS_REGION="$_REG" INSTANCE_ID="$_IID" SSH_KEY="$_KEY" SSH_USER="${_USER:-ubuntu}" \
      DB_NAME="${_DBN:-dailyloop}" DB_USER="${_DBU:-dailyloop}" DB_PASS="$_DBP" bash setup-aws-db.sh )
  [ -f aws/DATABASE_URL.txt ] || die "Provisioning Postgres thất bại."
  upsert DATABASE_URL "$(cat aws/DATABASE_URL.txt)"
  ok "Postgres sẵn sàng, đã ghi DATABASE_URL vào .env"
fi

# ---------- 4. Ollama (native trên Mac) ----------
bold "[4/7] Ollama + model"
if [ "$(getenv USE_REAL_OLLAMA)" = "true" ]; then
  command -v ollama >/dev/null 2>&1 || { command -v brew >/dev/null 2>&1 && brew install ollama || die "Cài Ollama: https://ollama.com/download"; }
  pgrep -x ollama >/dev/null 2>&1 || { nohup ollama serve >/tmp/ollama.log 2>&1 & sleep 3; }
  MODEL="$(getenv OLLAMA_MODEL)"; MODEL="${MODEL:-qwen3-coder:30b}"
  ollama list 2>/dev/null | grep -q "${MODEL%%:*}" || ollama pull "$MODEL"
  ok "Ollama chạy + model $MODEL"
else
  ok "USE_REAL_OLLAMA=false → bỏ qua (Prototyper dùng fallback)"
fi

# ---------- 5. GitHub + Claude ----------
bold "[5/7] Kiểm tra GitHub token & Claude key"
gh_login=$(curl -fsS -H "Authorization: Bearer $(getenv GITHUB_TOKEN)" https://api.github.com/user 2>/dev/null | grep -o '"login"[^,]*' | head -1) \
  || die "GITHUB_TOKEN không hợp lệ — xem SETUP.md mục GitHub."
ok "GitHub token hợp lệ ($gh_login)"
if [ -n "$(getenv ANTHROPIC_API_KEY)" ]; then
  ok "ANTHROPIC_API_KEY đã đặt"
elif [ -d "$HOME/.claude" ]; then
  ok "Dùng Claude Max session (~/.claude → mount vào container)"
else
  die "Thiếu ANTHROPIC_API_KEY và chưa có ~/.claude. Chạy 'claude' login trên Mac trước, hoặc điền key."
fi

# ---------- 6. Build & run ----------
bold "[6/7] Build & chạy Docker"
docker compose up -d --build
ok "container đang chạy"

# ---------- 7. Smoke test ----------
bold "[7/7] Smoke test"
sleep 4
docker compose exec -T orchestrator bun run daily-loop.ts generate >/dev/null 2>&1 && ok "sinh thử 1 ý tưởng OK" || echo "   (smoke test bỏ qua — kiểm tra: docker compose logs)"

echo ""
bold "✅ XONG."
echo "   Dashboard : $(getenv BASE_URL)"
echo "   Database  : $(getenv DATABASE_URL)"
echo "   Logs      : docker compose logs -f"
echo ""
echo "   Lưu ý: executor (build thật qua gstack) hiện ở chế độ mock. Bật khi đã wire gstack:"
echo "          đặt USE_REAL_CLAUDE=true trong .env rồi: docker compose up -d --build"
