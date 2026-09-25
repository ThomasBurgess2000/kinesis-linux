#!/usr/bin/env bash
# Swap the loaded bluetooth module for the one depmod now resolves (patched or stock), without a
# reboot. Every open Bluetooth socket pins the module, so bluetoothd and the desktop services that
# keep sockets open (WirePlumber's SCO socket, KDE Connect's RFCOMM socket) are stopped for the
# swap. Drivers and services are always restored on exit. Run as root (install.sh/uninstall.sh).
set -euo pipefail

user=${SUDO_USER:-}
user_units=(wireplumber.service app-org.kde.kdeconnect.daemon@autostart.service obex.service)
# bluetooth.service is D-Bus activated (org.bluez): any client touching BlueZ restarts it, so it
# is masked for the swap. --runtime masks vanish on reboot, and restore() unmasks them anyway.
bluez_units=(bluetooth.service)  # its dbus-org.bluez.service alias resolves to this unit
loaded=$(lsmod | awk '$1 ~ /^(btusb|btrtl|btmtk|btintel|btbcm|rfcomm|bnep|hidp)$/ {print $1}')
stopped_units=()

restore() {
  modprobe bluetooth || true
  for m in $loaded; do modprobe "$m" || true; done
  systemctl unmask --runtime "${bluez_units[@]}" 2>/dev/null || true
  systemctl start bluetooth || true
  for unit in "${stopped_units[@]}"; do systemctl --user -M "$user@" start "$unit" || true; done
}
trap restore EXIT

# Which processes hold the Bluetooth sockets still open (kernel-internal ones have inode 0).
holders() {
  declare -A owner
  for fd in /proc/[0-9]*/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    [[ $link == socket:* ]] || continue
    pid=${fd#/proc/}; pid=${pid%%/*}
    owner[${link//[^0-9]/}]="$pid $(cat "/proc/$pid/comm" 2>/dev/null)"
  done
  for table in l2cap sco rfcomm hci iso; do
    [ -r "/proc/net/$table" ] || continue
    awk 'NR > 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/ && length($i) > 4) print $i }' "/proc/net/$table" \
      | sort -u | while read -r inode; do echo "  $table socket held by ${owner[$inode]:-unknown}"; done
  done
}

# Desktop clients first (they talk to BlueZ on the way down), then mask and stop bluetoothd.
if [ -n "$user" ]; then
  for unit in "${user_units[@]}"; do
    if systemctl --user -M "$user@" is-active --quiet "$unit"; then
      systemctl --user -M "$user@" stop "$unit"
      stopped_units+=("$unit")
    fi
  done
fi
systemctl mask --runtime "${bluez_units[@]}"
systemctl stop bluetooth
modprobe -r btusb rfcomm bnep hidp 2>/dev/null || true
if ! modprobe -r bluetooth; then
  echo "bluetooth is still in use (lsmod: $(lsmod | awk '$1 == "bluetooth" {print $3 " users " $4}'))" >&2
  holders >&2
  exit 1
fi
modprobe bluetooth
echo "Reloaded bluetooth: srcversion $(cat /sys/module/bluetooth/srcversion)"
