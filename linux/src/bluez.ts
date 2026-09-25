// BlueZ over D-Bus through busctl: discovery, GATT reads, pairing, and battery.
// No native D-Bus library is needed; busctl ships with systemd on every BlueZ system.
// Replies are parsed from busctl's typed text output (see dbus-text.ts).

import { $ } from "bun";
import { type PropertyMap, asMap, getBoolean, getNumber, getString, getStrings, parseReply } from "./dbus-text";
import type { BandDevice } from "./gestures";

export const BAND_SERVICE = "0000feb8-0000-1000-8000-00805f9b34fb";
export const PSM_CHARACTERISTIC = "2d41da7c-82b6-42aa-b34e-e2e01df8cc1a";
export const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
export const BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb";

export class BluezError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluezError";
  }
}

/// path -> interface -> properties
export type Objects = Map<string, Map<string, PropertyMap>>;

async function busctl(args: string[], timeoutSeconds = 30): Promise<string> {
  const result = await $`busctl --timeout=${timeoutSeconds} ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const message = result.stderr.toString().trim() || result.stdout.toString().trim() || `busctl exited ${result.exitCode}`;
    throw new BluezError(message.replace(/^Call failed: /, ""));
  }
  return result.stdout.toString();
}

export async function objects(): Promise<Objects> {
  const raw = await busctl(["call", "org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"]);
  const [tree] = parseReply(raw);
  const out: Objects = new Map();
  for (const [path, ifaces] of asMap(tree)) {
    const byInterface = new Map<string, PropertyMap>();
    for (const [name, props] of asMap(ifaces)) byInterface.set(String(name), asMap(props));
    out.set(String(path), byInterface);
  }
  return out;
}

export function devicePath(adapter: string, address: string): string {
  return `${adapter}/dev_${address.replace(/:/g, "_")}`;
}

export async function adapterPath(): Promise<string> {
  const all = await objects();
  for (const [path, ifaces] of all) {
    const adapter = ifaces.get("org.bluez.Adapter1");
    if (!adapter) continue;
    if (getBoolean(adapter, "Powered") !== true) throw new BluezError("Bluetooth is turned off. Turn it on to connect your band.");
    return path;
  }
  throw new BluezError("No Bluetooth adapter found. Is bluetoothd running?");
}

function deviceFrom(props: PropertyMap): BandDevice | undefined {
  const address = getString(props, "Address");
  if (!address) return undefined;
  const name = getString(props, "Name") ?? getString(props, "Alias") ?? "";
  const rssi = getNumber(props, "RSSI");
  return {
    address,
    addressType: getString(props, "AddressType") === "random" ? "random" : "public",
    name,
    ...(rssi !== undefined ? { rssi } : {}),
  };
}

export function isBandName(name: string): boolean {
  return name.toLowerCase().startsWith("meta band");
}

// BlueZ ties a discovery session to the D-Bus client that started it. `busctl call StartDiscovery`
// exits as soon as the reply arrives, so BlueZ drops that session at once and nothing is scanned.
// Hold the session with a long-lived bluetoothctl process for as long as we need to discover.
let discoverySession: ReturnType<typeof Bun.spawn> | undefined;

export function holdDiscovery(maxSeconds = 600): void {
  if (discoverySession && discoverySession.exitCode === null) return;
  discoverySession = Bun.spawn(["bluetoothctl", "--timeout", String(maxSeconds), "scan", "on"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
}

export async function releaseDiscovery(): Promise<void> {
  const proc = discoverySession;
  discoverySession = undefined;
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  await proc.exited.catch(() => {});
}

/// Scan for advertising bands. Already-known bands are listed even if quiet, without an RSSI.
export async function scan(seconds: number, onProgress?: (found: BandDevice[]) => void): Promise<BandDevice[]> {
  const adapter = await adapterPath();
  holdDiscovery(seconds + 5);
  const found = new Map<string, BandDevice>();
  const deadline = Date.now() + seconds * 1000;
  try {
    while (Date.now() < deadline) {
      for (const [path, ifaces] of await objects()) {
        if (!path.startsWith(adapter + "/dev_")) continue;
        const props = ifaces.get("org.bluez.Device1");
        const device = props && deviceFrom(props);
        if (device && isBandName(device.name)) found.set(device.address, device);
      }
      onProgress?.([...found.values()]);
      await Bun.sleep(1000);
    }
  } finally {
    await releaseDiscovery();
  }
  return [...found.values()].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
}

/// Scan until the band advertises, then leave discovery stopped and settled so the following
/// Connect is not aborted. Matches the saved identity address first, else any advertising Meta
/// Band (a re-synced band may advertise an address that does not resolve to the saved identity).
export async function discoverBand(saved: BandDevice, seconds: number): Promise<{ path: string; device: BandDevice } | undefined> {
  const adapter = await adapterPath();
  const deadline = Date.now() + seconds * 1000;
  // Remove every cached Meta Band object first. Each button press makes the band advertise a new
  // resolvable-private address, and BlueZ keeps the old objects with a stale RSSI; picking one of
  // those connects to an address the band no longer uses and times out. After removal, only the
  // address the band is advertising *right now* reappears. A bonded band is kept (removing it
  // erases the pairing keys the band asks for on connect), but its object keeps the RSSI of an
  // old sighting, so it only counts once that RSSI changes: BlueZ has then resolved the band's
  // current address from a fresh advertisement and a connect goes to the live address.
  const staleRssi = new Map<string, number | undefined>();
  for (const [path, ifaces] of await objects()) {
    if (!path.startsWith(adapter + "/dev_")) continue;
    const props = ifaces.get("org.bluez.Device1");
    const device = props && deviceFrom(props);
    if (!device || !isBandName(device.name)) continue;
    const bonded = getBoolean(props, "Paired") === true || getBoolean(props, "Bonded") === true;
    if (bonded) staleRssi.set(path, device.rssi);
    else await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "RemoveDevice", "o", path], 10).catch(() => {});
  }
  holdDiscovery(seconds + 5);
  try {
    while (Date.now() < deadline) {
      // Poll fast so we connect the instant the band appears: its connectable window after a
      // button press is only a few seconds, so any settle delay here means we miss it.
      await Bun.sleep(600);
      const candidates: { path: string; device: BandDevice }[] = [];
      for (const [path, ifaces] of await objects()) {
        if (!path.startsWith(adapter + "/dev_")) continue;
        const props = ifaces.get("org.bluez.Device1");
        const device = props && deviceFrom(props);
        if (!device || !isBandName(device.name) || device.rssi === undefined) continue;
        if (staleRssi.has(path) && staleRssi.get(path) === device.rssi) continue; // not seen yet
        candidates.push({ path, device });
      }
      // Freshly (re-)discovered, so the strongest signal is the live one.
      const chosen = candidates.sort((a, b) => (b.device.rssi ?? -127) - (a.device.rssi ?? -127))[0];
      if (chosen) {
        await releaseDiscovery();
        return chosen;
      }
    }
  } finally {
    await releaseDiscovery();
  }
  return undefined;
}

export async function isDiscovering(): Promise<boolean> {
  const adapter = await adapterPath();
  const props = (await objects()).get(adapter)?.get("org.bluez.Adapter1");
  return props ? getBoolean(props, "Discovering") === true : false;
}

/// Ends our own discovery session. Sessions held by other clients are left alone.
export async function stopDiscovery(): Promise<void> {
  await releaseDiscovery();
}

export async function knownDevice(address: string): Promise<BandDevice | undefined> {
  const adapter = await adapterPath();
  const props = (await objects()).get(devicePath(adapter, address))?.get("org.bluez.Device1");
  return props ? deviceFrom(props) : undefined;
}

export async function deviceByPath(path: string): Promise<BandDevice | undefined> {
  const props = (await objects()).get(path)?.get("org.bluez.Device1");
  return props ? deviceFrom(props) : undefined;
}

/// The currently-connected Meta Band object. After pairing, BlueZ may move the device from the
/// advertised random-address path to its identity path, so callers must re-resolve by connection.
export async function connectedBand(): Promise<{ path: string; device: BandDevice } | undefined> {
  for (const [path, ifaces] of await objects()) {
    const props = ifaces.get("org.bluez.Device1");
    if (!props || getBoolean(props, "Connected") !== true) continue;
    const device = deviceFrom(props);
    if (device && isBandName(device.name)) return { path, device };
  }
  return undefined;
}

/// Finds the saved band in BlueZ's cache. The band advertises with a rotating private address;
/// once BlueZ bonds with it the Device1 Address becomes the identity address while the object
/// path may keep the old one, so match by address, then path, then unique name.
export async function findDevice(saved: BandDevice): Promise<{ path: string; device: BandDevice } | undefined> {
  const adapter = await adapterPath();
  const candidates: { path: string; device: BandDevice }[] = [];
  for (const [path, ifaces] of await objects()) {
    if (!path.startsWith(adapter + "/dev_")) continue;
    const props = ifaces.get("org.bluez.Device1");
    const device = props && deviceFrom(props);
    if (device) candidates.push({ path, device });
  }
  const byAddress = candidates.find((c) => c.device.address.toUpperCase() === saved.address.toUpperCase());
  if (byAddress) return byAddress;
  const byPath = candidates.find((c) => c.path === devicePath(adapter, saved.address));
  if (byPath) return byPath;
  const byName = candidates.filter((c) => saved.name && c.device.name === saved.name);
  return byName.length === 1 ? byName[0] : undefined;
}

async function property(path: string, iface: string, name: string): Promise<unknown> {
  const raw = await busctl(["get-property", "org.bluez", path, iface, name], 10);
  return parseReply(raw)[0];
}

export interface DeviceState {
  connected: boolean;
  paired: boolean;
  bonded: boolean;
  trusted: boolean;
  servicesResolved: boolean;
}

export async function deviceState(path: string): Promise<DeviceState> {
  const props = (await objects()).get(path)?.get("org.bluez.Device1");
  if (!props) throw new BluezError("This band isn't known to BlueZ yet. Run a scan with it in pairing mode.");
  return {
    connected: getBoolean(props, "Connected") === true,
    paired: getBoolean(props, "Paired") === true,
    bonded: getBoolean(props, "Bonded") === true,
    trusted: getBoolean(props, "Trusted") === true,
    servicesResolved: getBoolean(props, "ServicesResolved") === true,
  };
}

/// Connect the LE link through BlueZ so GATT is available and the L2CAP socket can share the ACL.
export async function connect(path: string, timeoutSeconds = 18): Promise<void> {
  await busctl(["call", "org.bluez", path, "org.bluez.Device1", "Connect"], timeoutSeconds);
  const deadline = Date.now() + Math.max(8000, timeoutSeconds * 1000);
  while (Date.now() < deadline) {
    if ((await property(path, "org.bluez.Device1", "ServicesResolved")) === true) return;
    await Bun.sleep(250);
  }
  throw new BluezError("The band connected but its services never resolved.");
}

export async function disconnect(path: string): Promise<void> {
  await busctl(["call", "org.bluez", path, "org.bluez.Device1", "Disconnect"], 15).catch(() => {});
}

export async function pair(path: string): Promise<void> {
  const state = await deviceState(path);
  if (!state.paired) {
    try {
      await busctl(["call", "org.bluez", path, "org.bluez.Device1", "Pair"], 90);
    } catch (error) {
      if (!(error instanceof BluezError && /AlreadyExists/.test(error.message))) throw error;
    }
  }
  await busctl(["set-property", "org.bluez", path, "org.bluez.Device1", "Trusted", "b", "true"], 10);
}

export async function removeDevice(address: string): Promise<void> {
  const adapter = await adapterPath();
  await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "RemoveDevice", "o", devicePath(adapter, address)], 15);
}

export async function removeDeviceByPath(adapter: string, path: string): Promise<void> {
  await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "RemoveDevice", "o", path], 15);
}

export async function characteristicPath(device: string, uuid: string): Promise<string | undefined> {
  for (const [path, ifaces] of await objects()) {
    if (!path.startsWith(device + "/")) continue;
    const props = ifaces.get("org.bluez.GattCharacteristic1");
    if (props && getString(props, "UUID")?.toLowerCase() === uuid) return path;
  }
  return undefined;
}

export async function hasService(device: string, uuid: string): Promise<boolean> {
  const props = (await objects()).get(device)?.get("org.bluez.Device1");
  return props ? getStrings(props, "UUIDs").map((u) => u.toLowerCase()).includes(uuid) : false;
}

export async function readCharacteristic(path: string): Promise<Uint8Array> {
  const raw = await busctl(["call", "org.bluez", path, "org.bluez.GattCharacteristic1", "ReadValue", "a{sv}", "0"], 15);
  const [value] = parseReply(raw);
  if (!(value instanceof Uint8Array)) throw new BluezError("Unexpected characteristic value format");
  return value;
}

/// Battery percent from BlueZ's Battery1 interface, falling back to the GATT level characteristic.
export async function batteryPercent(device: string): Promise<number | undefined> {
  const percent = await property(device, "org.bluez.Battery1", "Percentage").catch(() => undefined);
  if (typeof percent === "number" && percent >= 0 && percent <= 100) return percent;
  const path = await characteristicPath(device, BATTERY_LEVEL);
  if (!path) return undefined;
  const value = await readCharacteristic(path).catch(() => undefined);
  return value && value.length === 1 && value[0]! <= 100 ? value[0] : undefined;
}
