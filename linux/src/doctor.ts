// Environment checks shared by `kinesis doctor` and the app's diagnostics.

import { KdeBackend } from "./actions";
import * as bluez from "./bluez";
import { configPath, loadConfig } from "./config";
import type { BandDevice } from "./gestures";
import { BandIdentity } from "./identity";
import { AF_BLUETOOTH, BTPROTO_L2CAP, SOCK_SEQPACKET, libc } from "./l2cap";
import { MetaSessionStore } from "./meta-auth";

export interface DoctorRow {
  name: string;
  ok: boolean;
  detail: string;
}

export function describeDevice(device: BandDevice, scanning = false): string {
  const signal = device.rssi !== undefined ? `  rssi ${device.rssi}` : scanning ? "  (not advertising)" : "";
  return `${device.name || "Meta Band"}  ${device.address}  ${device.addressType}${signal}`;
}

export async function doctorRows(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const check = (name: string, ok: boolean, detail = "") => rows.push({ name, ok, detail });
  try {
    check("BlueZ adapter", true, await bluez.adapterPath());
  } catch (error) {
    check("BlueZ adapter", false, error instanceof Error ? error.message : String(error));
  }
  const fd = libc.symbols.socket(AF_BLUETOOTH, SOCK_SEQPACKET, BTPROTO_L2CAP);
  check("L2CAP socket", fd >= 0, fd >= 0 ? "kernel allows AF_BLUETOOTH sockets" : "socket() failed; check bluetooth kernel modules");
  if (fd >= 0) libc.symbols.close(fd);
  check("busctl", Bun.which("busctl") !== null, Bun.which("busctl") ?? "install systemd");
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? "";
  check("Desktop", desktop.length > 0, `${desktop || "unknown"} on ${process.env.XDG_SESSION_TYPE ?? "unknown session"}`);
  check("KDE backend", KdeBackend.available(), KdeBackend.available() ? "qdbus found" : "not KDE or qdbus missing; use the command backend");
  const ydotool = Bun.which("ydotool");
  check("ydotool", ydotool !== null, ydotool ? "used for Escape and tab switching" : "optional; needed for dismiss/previousTab/nextTab on KDE");
  const config = await loadConfig();
  check("Saved band", config.band !== undefined, config.band ? describeDevice(config.band) : "pair a band first");
  if (config.band) {
    const known = await bluez.knownDevice(config.band.address).catch(() => undefined);
    check("Band known to BlueZ", known !== undefined, known ? describeDevice(known) : "put the band in pairing mode and pair it");
    if (known) {
      const adapter = await bluez.adapterPath();
      const state = await bluez.deviceState(bluez.devicePath(adapter, known.address)).catch(() => undefined);
      if (state) check("Band state", true, `connected ${state.connected}, paired ${state.paired}, trusted ${state.trusted}`);
    }
    const enrolled = await BandIdentity.exists(config.band.address);
    check("Band enrollment", enrolled, enrolled ? BandIdentity.path(config.band.address) : "claim the band for stable sessions");
  }
  const metaSession = await MetaSessionStore.restore();
  check("Meta session", metaSession !== undefined, metaSession ? `user ${metaSession.userID}` : "sign in once to claim a band");
  if (await patchedBluetoothLoaded()) {
    check("Kernel L2CAP credits", true, "patched bluetooth module loaded (kernel-fix)");
  } else {
    const identErrors = await kernelIdentErrors();
    if (identErrors !== undefined) {
      check("Kernel L2CAP credits", identErrors === 0, identErrors === 0
        ? "stock module; no ident exhaustion logged this boot"
        : `${identErrors} "Unable to allocate ident" errors this boot; install linux/kernel-fix`);
    }
  }
  check("Config", true, configPath());
  return rows;
}

/// Whether the running bluetooth module is the one kernel-fix/install.sh put in updates/kinesis.
async function patchedBluetoothLoaded(): Promise<boolean> {
  const release = (await Bun.file("/proc/sys/kernel/osrelease").text().catch(() => "")).trim();
  const patched = `/lib/modules/${release}/updates/kinesis/bluetooth.ko`;
  const modinfo = Bun.which("modinfo") ?? "/usr/sbin/modinfo";
  if (!release || !(await Bun.file(patched).exists())) return false;
  const loaded = (await Bun.file("/sys/module/bluetooth/srcversion").text().catch(() => "")).trim();
  const proc = Bun.spawn([modinfo, "-F", "srcversion", patched], { stdout: "pipe", stderr: "ignore" });
  const expected = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return loaded !== "" && loaded === expected;
}

/// Count this boot's "Unable to allocate ident" kernel errors (the L2CAP credit-ident leak that
/// stalls band streams; see kernel-fix/). Undefined when the journal isn't readable.
async function kernelIdentErrors(): Promise<number | undefined> {
  const journalctl = Bun.which("journalctl");
  if (!journalctl) return undefined;
  const proc = Bun.spawn([journalctl, "-k", "-b", "--no-pager", "-g", "Unable to allocate ident", "-o", "cat"], {
    stdout: "pipe", stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  // journalctl -g exits 1 when nothing matches.
  if (code !== 0 && code !== 1) return undefined;
  return text.split("\n").filter((line) => line.includes("allocate ident")).length;
}
