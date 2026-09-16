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

/// Scan for advertising bands. Already-known bands are listed even if quiet, without an RSSI.
export async function scan(seconds: number, onProgress?: (found: BandDevice[]) => void): Promise<BandDevice[]> {
  const adapter = await adapterPath();
  await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "SetDiscoveryFilter", "a{sv}", "1", "Transport", "s", "le"]).catch(() => {});
  let started = false;
  try {
    await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "StartDiscovery"]);
    started = true;
  } catch (error) {
    if (!(error instanceof BluezError && /InProgress/.test(error.message))) throw error;
  }
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
    if (started) await busctl(["call", "org.bluez", adapter, "org.bluez.Adapter1", "StopDiscovery"]).catch(() => {});
  }
  return [...found.values()].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
}

export async function knownDevice(address: string): Promise<BandDevice | undefined> {
  const adapter = await adapterPath();
  const props = (await objects()).get(devicePath(adapter, address))?.get("org.bluez.Device1");
  return props ? deviceFrom(props) : undefined;
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
export async function connect(path: string, timeoutSeconds = 30): Promise<void> {
  await busctl(["call", "org.bluez", path, "org.bluez.Device1", "Connect"], timeoutSeconds);
  const deadline = Date.now() + 20_000;
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
