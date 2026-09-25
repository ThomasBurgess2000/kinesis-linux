#!/usr/bin/env bash
# Install the patched bluetooth.ko built by build.sh into /lib/modules/<release>/updates, which
# Ubuntu's depmod prefers over the stock module. For the running kernel it also swaps the module
# live: Bluetooth devices disconnect for a few seconds and reconnect on their own.
#
# usage: sudo install.sh [kernel-release ...]   (default: the running kernel)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

user_home=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
WORK=${KINESIS_KFIX_WORK:-$user_home/.cache/kinesis-kernel-fix}
releases=("$@")
[ ${#releases[@]} -eq 0 ] && releases=("$(uname -r)")

for release in "${releases[@]}"; do
  built=$WORK/$release/bluetooth.ko
  [ -f "$built" ] || { echo "$release: $built not found; run build.sh $release first" >&2; exit 1; }
  install -D -m 0644 "$built" "/lib/modules/$release/updates/kinesis/bluetooth.ko"
  depmod -a "$release"
  echo "$release: installed $(modinfo -k "$release" -n bluetooth)"
done

running=$(uname -r)
if [[ " ${releases[*]} " == *" $running "* ]]; then
  echo "Reloading Bluetooth on $running (devices and audio reconnect in a few seconds)…"
  "$(dirname "$0")/reload.sh"
  if [ "$(cat /sys/module/bluetooth/srcversion)" = "$(modinfo -F srcversion "/lib/modules/$running/updates/kinesis/bluetooth.ko")" ]; then
    echo "Patched bluetooth module is live."
  else
    echo "Warning: the running bluetooth module isn't the patched one; a reboot will pick it up." >&2
  fi
fi
