#!/usr/bin/env bash
# install-launchd.sh — Đăng ký mirotic worker với launchd (Mac).
# Chạy:  ./infra/mac/install-launchd.sh         # cài + start
#        ./infra/mac/install-launchd.sh stop    # dừng
#        ./infra/mac/install-launchd.sh remove  # gỡ hẳn
#        ./infra/mac/install-launchd.sh status  # xem trạng thái
set -euo pipefail

LABEL="io.mirotic"
# infra/mac/install-launchd.sh → 2 levels up = project root.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST_SRC="$ROOT/infra/mac/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/mirotic"

cmd="${1:-install}"

case "$cmd" in
  install)
    mkdir -p "$LOG_DIR"
    mkdir -p "$(dirname "$PLIST_DEST")"
    sed "s|__WORKDIR__|$ROOT|g; s|__HOME__|$HOME|g" "$PLIST_SRC" > "$PLIST_DEST"
    chmod 644 "$PLIST_DEST"
    # bootout (idempotent) rồi bootstrap
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "✓ installed + started: $LABEL"
    echo "  logs: $LOG_DIR/{stdout,stderr}.log"
    echo "  status: ./infra/mac/install-launchd.sh status"
    ;;
  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "✓ stopped" || echo "(not loaded)"
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "✓ removed"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>&1 | head -30 || echo "(not loaded)"
    echo "---"
    echo "Last stderr:"
    tail -5 "$LOG_DIR/stderr.log" 2>/dev/null || echo "(no log yet)"
    ;;
  *)
    echo "Usage: $0 {install|stop|remove|status}"; exit 1
    ;;
esac
