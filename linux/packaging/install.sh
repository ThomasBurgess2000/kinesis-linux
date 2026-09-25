#!/usr/bin/env bash
# Install the Kinesis app for the current user (no sudo): the kinesis.service user unit that owns
# the band, the "Kinesis" launcher, and login autostart for the tray. Re-run after moving the repo.
#
# usage: packaging/install.sh [--uninstall]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
UNIT=$CONFIG/systemd/user/kinesis.service
LAUNCHER=$DATA/applications/kinesis.desktop
AUTOSTART=$CONFIG/autostart/kinesis.desktop

fill() { sed -e "s|@REPO@|$REPO|g" -e "s|@BUN@|$BUN|g" "$1"; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now kinesis.service 2>/dev/null || true
  rm -f "$UNIT" "$LAUNCHER" "$AUTOSTART"
  systemctl --user daemon-reload
  command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" || true
  echo "Kinesis app removed. Your band pairing and settings are kept (kinesis forget removes them)."
  exit 0
fi

BUN=$(command -v bun || true)
[ -n "$BUN" ] || { echo "bun isn't on your PATH; install it from https://bun.sh first." >&2; exit 1; }
BUN=$(readlink -f "$BUN")

if ! python3 -c "from PySide6 import QtQml, QtQuick, QtNetwork, QtWidgets" 2>/dev/null; then
  echo "The window needs PySide6's QML modules. Install them, then re-run this script:" >&2
  echo "  sudo apt install python3-pyside6.qtqml python3-pyside6.qtquick python3-pyside6.qtnetwork" >&2
  exit 1
fi

mkdir -p "$(dirname "$UNIT")" "$(dirname "$LAUNCHER")" "$(dirname "$AUTOSTART")"
fill "$HERE/kinesis.service" > "$UNIT"
fill "$HERE/kinesis.desktop" > "$LAUNCHER"
fill "$HERE/kinesis-autostart.desktop" > "$AUTOSTART"
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" || true

systemctl --user daemon-reload
systemctl --user enable --now kinesis.service
echo "Installed:"
echo "  $UNIT (running: $(systemctl --user is-active kinesis.service))"
echo "  $LAUNCHER  — \"Kinesis\" in your app launcher"
echo "  $AUTOSTART — tray icon at login"
echo
echo "Opening Kinesis…"
setsid -f /usr/bin/env python3 "$REPO/ui/kinesis-ui.py" >/dev/null 2>&1 < /dev/null
