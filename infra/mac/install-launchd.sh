#!/usr/bin/env bash
# install-launchd.sh — Đăng ký mirotic với launchd (Mac). Hai job:
#   io.mirotic        — poller thường trú (build/deploy queue), KeepAlive.
#   io.mirotic.batch  — batch ý tưởng mỗi sáng lúc MORNING_AT (StartCalendarInterval, chạy bù khi ngủ dậy).
# Chạy:  ./infra/mac/install-launchd.sh         # cài + start cả 2
#        ./infra/mac/install-launchd.sh stop    # dừng cả 2
#        ./infra/mac/install-launchd.sh remove  # gỡ hẳn cả 2
#        ./infra/mac/install-launchd.sh status  # xem trạng thái
#        ./infra/mac/install-launchd.sh batch   # chạy batch NGAY (một lần, để test)
set -euo pipefail

LABELS=("io.mirotic" "io.mirotic.batch")
# infra/mac/install-launchd.sh → 2 levels up = project root.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/mirotic"

# Giờ batch lấy từ MORNING_AT trong .env (HH:MM), default 04:32.
MORNING_AT="$(grep -E '^MORNING_AT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d ' ')"
MORNING_AT="${MORNING_AT:-04:32}"
BATCH_HOUR="$((10#${MORNING_AT%%:*}))"     # strip leading zero (base-10) để không thành octal
BATCH_MIN="$((10#${MORNING_AT##*:}))"

render() {   # render <label> → $HOME/Library/LaunchAgents/<label>.plist
  local label="$1"
  local src="$ROOT/infra/mac/$label.plist"
  local dest="$HOME/Library/LaunchAgents/$label.plist"
  sed "s|__WORKDIR__|$ROOT|g; s|__HOME__|$HOME|g; s|__HOUR__|$BATCH_HOUR|g; s|__MINUTE__|$BATCH_MIN|g" \
    "$src" > "$dest"
  chmod 644 "$dest"
  echo "$dest"
}

cmd="${1:-install}"

case "$cmd" in
  install)
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
    for label in "${LABELS[@]}"; do
      dest="$(render "$label")"
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$dest"
      echo "✓ loaded: $label"
    done
    # Chỉ kickstart poller (batch chạy theo lịch, không kick lúc cài).
    launchctl kickstart -k "gui/$(id -u)/io.mirotic"
    echo "✓ installed + started (batch lúc ${MORNING_AT} mỗi ngày)"
    echo "  logs: $LOG_DIR/{stdout,stderr}.log"
    ;;
  stop)
    for label in "${LABELS[@]}"; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null && echo "✓ stopped: $label" || echo "(not loaded: $label)"
    done
    ;;
  remove)
    for label in "${LABELS[@]}"; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$label.plist"
      echo "✓ removed: $label"
    done
    ;;
  status)
    for label in "${LABELS[@]}"; do
      echo "=== $label ==="
      launchctl print "gui/$(id -u)/$label" 2>&1 | grep -E "state =|last exit|program =|runs =" || echo "(not loaded)"
    done
    echo "--- Last stderr ---"
    tail -5 "$LOG_DIR/stderr.log" 2>/dev/null || echo "(no log yet)"
    ;;
  batch)
    launchctl kickstart -k "gui/$(id -u)/io.mirotic.batch" && echo "✓ batch chạy ngay (xem $LOG_DIR/stdout.log)"
    ;;
  *)
    echo "Usage: $0 {install|stop|remove|status|batch}"; exit 1
    ;;
esac
