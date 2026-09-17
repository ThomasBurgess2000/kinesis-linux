// Direct connect to an existing Meta Band BlueZ object (no advertising gate), then run the
// normal subscription and log gestures/motion for 45 s. For debugging the worn-gesture path.
import * as bluez from "../src/bluez";
import { L2capChannel } from "../src/l2cap";
import { BandSession } from "../src/session";
import { loadConfig } from "../src/config";
import { hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();

// Find any Meta Band device object BlueZ already knows (advertising or not).
const all = await bluez.objects();
let path = "";
let addr = "";
let type: "public" | "random" = "random";
for (const [p, ifaces] of all) {
  const d = ifaces.get("org.bluez.Device1");
  if (!d) continue;
  const name = String(d.get("Name")?.data ?? d.get("Alias")?.data ?? "");
  if (name.toLowerCase().startsWith("meta band")) {
    path = p; addr = String(d.get("Address")?.data ?? "");
    type = d.get("AddressType")?.data === "random" ? "random" : "public";
    break;
  }
}
if (!path) { console.error("No Meta Band object in BlueZ. Press the button and run scan first."); process.exit(1); }
log(`target ${path} ${addr} (${type})`);

await bluez.stopDiscovery().catch(() => {});
for (let i = 0; i < 30 && (await bluez.isDiscovering().catch(() => false)); i++) await Bun.sleep(300);
log(`discovering=${await bluez.isDiscovering().catch(() => "?")}`);

for (let attempt = 1; attempt <= 6; attempt++) {
  try { log(`connect attempt ${attempt}`); await bluez.connect(path, 30); break; }
  catch (e) {
    log(`  failed: ${e instanceof Error ? e.message : String(e)}`);
    if (attempt === 6) process.exit(1);
    await bluez.disconnect(path).catch(() => {});
    await Bun.sleep(2000);
  }
}
const dev = await bluez.deviceByPath(path);
addr = dev?.address ?? addr; type = dev?.addressType ?? type;
const psmVal = await bluez.readCharacteristic((await bluez.characteristicPath(path, bluez.PSM_CHARACTERISTIC))!);
const psm = psmVal[0]! | (psmVal[1]! << 8);
log(`connected; psm=${psm} addr=${addr} (${type})`);

const session = new BandSession({ configChannel: config.configChannel });
let started = false;
const channel: L2capChannel = new L2capChannel({
  onOpen: () => { log("l2cap open; handshake"); channel.write(session.request()); },
  onData: (bytes) => {
    const r = session.feed(bytes, Number(Bun.nanoseconds()) / 1e9);
    for (const p of r.packets) channel.write(p);
    for (const e of r.events) {
      if (e.payload.type === "connected") { log("*** CONNECTED: streams enabled — do gestures now ***"); started = true; setTimeout(() => channel.close(), 45000); }
      else if (e.payload.type === "gesture" && !e.payload.gesture.synthetic) log(`GESTURE ${e.payload.gesture.finger}/${e.payload.gesture.action}/${e.payload.gesture.derivedAction}`);
      else if (e.payload.type === "dialState") log(`DIAL ${e.payload.engaged ? "engaged" : "released"}`);
      else if (e.payload.type === "dialTurn") log(`DIAL turn ${e.payload.rotation.toFixed(3)}`);
    }
    if (!started && session.authenticatedPackets > 3 && !session.streamsEnabled)
      log(`  frames flowing, streams not yet enabled (auth=${session.authenticatedPackets})`);
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"} (motion=${session.motionMessages})`); process.exit(0); },
  onLog: (m) => log(`  ${m}`),
});
channel.open({ address: addr, addressType: type, psm, security: "low" });
setTimeout(() => { log("overall timeout"); channel.close(); }, 70000);
