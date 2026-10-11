#!/usr/bin/env bash
# Manage the teamengaged systemd user service (Linux).
# Usage: scripts/service.sh install|restart|stop|status
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/teamengaged.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"

stop_spawned() {
  # Stop a daemon that was auto-spawned by a `te` command, so the service
  # can take the port.
  local f="$HOME/.teamengage/daemon.json"
  [ -f "$f" ] || return 0
  local pid
  pid="$(node -e 'console.log(require(process.env.HOME+"/.teamengage/daemon.json").pid)' 2>/dev/null || true)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  sleep 1
}

case "${1:-}" in
  install)
    stop_spawned
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT" <<EOF
[Unit]
Description=TeamEngage daemon

[Service]
ExecStart=$NODE_BIN $HERE/dist/daemon/main.js
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now teamengaged
    echo "teamengaged installed, enabled at login, and started"
    ;;
  restart)
    systemctl --user restart teamengaged
    echo "teamengaged restarted — run 'npm run ui' for a fresh login link"
    ;;
  stop)
    systemctl --user stop teamengaged
    ;;
  status)
    systemctl --user status teamengaged
    ;;
  *)
    echo "usage: $0 install|restart|stop|status" >&2
    exit 1
    ;;
esac
