#!/usr/bin/env bash
# Build a patched bluetooth.ko with upstream 6e1930ece855 ("Bluetooth: L2CAP: fix tx ident leak for
# commands without a response") for Ubuntu kernels that lack it. Without the fix the kernel leaks
# a signaling ident per LE credit packet; after 254 of them every credit goes out with ident 0,
# the band ignores it and the stream stalls (~37 s at full rate). No root needed.
#
# usage: build.sh [kernel-release ...]   (default: the running kernel)
# output: $WORK/<release>/bluetooth.ko, verified to export the same symbol CRCs as the stock module
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PATCH=$HERE/0001-Bluetooth-L2CAP-fix-tx-ident-leak.patch
WORK=${KINESIS_KFIX_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/kinesis-kernel-fix}
releases=("$@")
[ ${#releases[@]} -eq 0 ] && releases=("$(uname -r)")

for release in "${releases[@]}"; do
  headers=/lib/modules/$release/build
  [ -f "$headers/Module.symvers" ] || { echo "no headers for $release (install linux-headers-$release)" >&2; exit 1; }
  abi=${release%-generic}                       # 7.0.0-31
  base=${abi%-*}                                # 7.0.0
  version=$(apt-cache madison "linux-source-$base" | awk -v p="$abi." '$3 ~ "^"p {print $3; exit}')
  [ -n "$version" ] || { echo "linux-source-$base for $abi isn't in the archive" >&2; exit 1; }

  dir=$WORK/$release
  mkdir -p "$dir"
  deb=$dir/linux-source-${base}_${version}_all.deb
  [ -f "$deb" ] || (cd "$dir" && apt-get download "linux-source-$base=$version")
  src=$dir/linux-source-$base/net/bluetooth
  if [ ! -f "$src/l2cap_core.c" ]; then
    dpkg-deb --fsys-tarfile "$deb" | tar -xO "./usr/src/linux-source-$base/linux-source-$base.tar.bz2" \
      | tar -xj -C "$dir" "linux-source-$base/net/bluetooth"
  fi
  if ! grep -q 'ida_free(&conn->tx_ida, ident)' "$src/l2cap_core.c"; then
    patch -p1 -d "$dir/linux-source-$base" < "$PATCH"
  fi
  # Only bluetooth.ko changes; the rfcomm/bnep/hidp/cmtp sub-modules are left alone.
  { echo 'obj-m += bluetooth.o'; sed -n '/^bluetooth-y :=/,$p' "$src/Makefile"; } > "$src/Kbuild"
  make -C "$headers" M="$src" -j"$(nproc)" modules > "$dir/build.log" 2>&1 || { tail -20 "$dir/build.log" >&2; exit 1; }

  # The drivers that import from bluetooth (btusb, btintel, rfcomm, ...) were built against the
  # stock exports; the patched module must export exactly the same symbols with the same CRCs.
  diff <(awk '$3 ~ /net\/bluetooth\/bluetooth$/ {print $2, $1}' "$headers/Module.symvers" | sort) \
       <(awk '{print $2, $1}' "$src/Module.symvers" | sort) > /dev/null \
    || { echo "$release: exported symbol CRCs differ from the stock module; not using this build" >&2; exit 1; }
  [ "$(modinfo -F vermagic "$src/bluetooth.ko" | awk '{print $1}')" = "$release" ] || { echo "$release: vermagic mismatch" >&2; exit 1; }
  cp "$src/bluetooth.ko" "$dir/bluetooth.ko"
  echo "$release: built $dir/bluetooth.ko (exports match stock)"
done
