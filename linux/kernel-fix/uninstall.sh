#!/usr/bin/env bash
# Remove the patched bluetooth.ko and go back to Ubuntu's stock module (e.g. once Ubuntu ships
# 6e1930ece855). For the running kernel it swaps the module back live.
#
# usage: sudo uninstall.sh [kernel-release ...]   (default: the running kernel)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
releases=("$@")
[ ${#releases[@]} -eq 0 ] && releases=("$(uname -r)")

for release in "${releases[@]}"; do
  rm -f "/lib/modules/$release/updates/kinesis/bluetooth.ko"
  rmdir "/lib/modules/$release/updates/kinesis" 2>/dev/null || true
  depmod -a "$release"
  echo "$release: bluetooth is $(modinfo -k "$release" -n bluetooth)"
done

running=$(uname -r)
if [[ " ${releases[*]} " == *" $running "* ]]; then
  "$(dirname "$0")/reload.sh"
  echo "Stock bluetooth module reloaded."
fi
