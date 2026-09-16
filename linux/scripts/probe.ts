// One-shot diagnostic: connect once, run the handshake, and dump every decoded
// DataX frame with its payload. Used to study a firmware's link-setup replies.
// Not part of the shipped CLI. Run: bun run scripts/probe.ts
import * as bluez from "../src/bluez";
import { L2capChannel } from "../src/l2cap";
import { BandSession } from "../src/session";
import { loadConfig } from "../src/config";
import { hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band;
if (!band) { console.error("No band saved. Run `kinesis scan` first."); process.exit(1); }
const found = await bluez.findDevice(band);
if (!found) { console.error("Band not known to BlueZ."); process.exit(1); }
await bluez.disconnect(found.path);
await Bun.sleep(2000);
log(`connecting ${found.path}`);
for (let attempt = 1; ; attempt++) {
  try { await bluez.connect(found.path); break; }
  catch (e) {
    log(`connect attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
    if (attempt >= 6) process.exit(1);
    await Bun.sleep(3000);
  }
}
log("services resolved");
const resolved = (await bluez.findDevice(band))?.device ?? found.device;
const psmChar = await bluez.characteristicPath(found.path, bluez.PSM_CHARACTERISTIC);
const psmVal = await bluez.readCharacteristic(psmChar!);
const psm = psmVal[0]! | (psmVal[1]! << 8);
log(`psm=${psm} addr=${resolved.address} ${resolved.addressType}`);
const phased = process.env.PROBE_PHASED === "1" || config.linkSetup === "phased";
const configChannel = process.env.PROBE_CONFIGCH ? parseInt(process.env.PROBE_CONFIGCH, 16) : config.configChannel;
log(`session opts: phased=${phased} configChannel=0x${configChannel.toString(16)}`);
const session = new BandSession({ phasedLinkSetup: phased, configChannel });
let n = 0;
session.onFrame = (f) =>
  log(`  frame#${n++} ch=0x${f.channel.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}] len=${f.length} payload=${hex(f.payload.subarray(0, 64))}`);
const channel = new L2capChannel({
  onOpen: () => { log("l2cap open; sending request"); channel.write(session.request()); },
  onData: (bytes) => {
    const r = session.feed(bytes, Number(Bun.nanoseconds()) / 1e9);
    for (const p of r.packets) channel.write(p);
    for (const e of r.events) log(`  event ${e.payload.type}`);
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"}`); process.exit(0); },
  onLog: (m) => log(`  ${m}`),
});
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: "low" });
setTimeout(() => {
  log(`giving up. authPkts=${session.authenticatedPackets} streams=${session.streamsEnabled}`);
  channel.close();
}, 20000);
