// Link-setup experiment harness. Connects once, completes the AirShield handshake in
// manual mode (no auto subscription), then drives a scripted sequence of follow-up
// frames and logs the band's replies. Goal: find what clears the 0xc001 gate on newer
// firmware. Not part of the shipped CLI.
//
//   bun run scripts/experiment.ts
//   ENABLE7=1 ENABLE8=1 bun run scripts/experiment.ts   # add EnableEncryption fields 7/8
//   CONFIGCH=8007 bun run scripts/experiment.ts
//
import * as bluez from "../src/bluez";
import { L2capChannel } from "../src/l2cap";
import { BandSession, type SessionOptions } from "../src/session";
import { loadConfig } from "../src/config";
import { BandWire, concat, hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band;
if (!band) { console.error("No band saved. Run `kinesis scan` first."); process.exit(1); }

const opts: SessionOptions = { manualLinkSetup: true, configChannel: config.configChannel };
if (process.env.CONFIGCH) opts.configChannel = parseInt(process.env.CONFIGCH, 16);
if (process.env.ENABLE7) opts.enablePhasedSupported = process.env.ENABLE7 === "1";
if (process.env.ENABLE8 !== undefined) opts.enableServices = BigInt(process.env.ENABLE8);
log(`opts ${JSON.stringify({ ...opts, enableServices: opts.enableServices?.toString() })}`);

// This firmware's connectable window is short and bonding interferes with reconnect.
// Drop any stored bond, then scan the band fresh and connect in the same window.
if (process.env.KEEP_BOND !== "1") await bluez.removeDevice(band.address).catch(() => {});
let devicePath = "";
async function connectFresh(): Promise<void> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    log(`refreshing (attempt ${attempt})…`);
    const seen = await bluez.scan(6).catch(() => []);
    const advertising = seen.find((d) => d.address.toUpperCase() === band!.address.toUpperCase() && d.rssi !== undefined);
    if (!advertising) { log(`  not advertising yet`); continue; }
    const found = await bluez.findDevice(band!);
    if (!found) { log(`  advertising but no object path yet`); continue; }
    devicePath = found.path;
    log(`  advertising at rssi ${advertising.rssi}; settling discovery`);
    await bluez.stopDiscovery().catch(() => {});
    for (let i = 0; i < 20 && (await bluez.isDiscovering().catch(() => false)); i++) await Bun.sleep(250);
    await Bun.sleep(500);
    try { await bluez.connect(found.path, 20); return; }
    catch (e) {
      log(`  connect failed: ${e instanceof Error ? e.message : String(e)}`);
      await bluez.disconnect(found.path).catch(() => {});
    }
  }
  throw new Error("could not connect after 12 refresh attempts");
}
await connectFresh();
const found0 = { path: devicePath, device: (await bluez.findDevice(band))!.device };
const resolved = (await bluez.findDevice(band))?.device ?? found0.device;
const psmVal = await bluez.readCharacteristic((await bluez.characteristicPath(found0.path, bluez.PSM_CHARACTERISTIC))!);
const psm = psmVal[0]! | (psmVal[1]! << 8);
log(`connected ${resolved.address} psm=${psm}`);

const session = new BandSession(opts);
let handshakeDone = false;
session.onFrame = (f) =>
  log(`  <- ch=0x${f.channel.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}] len=${f.length}${f.payload.length ? " " + hex(f.payload.subarray(0, 48)) : ""}`);

let channel: L2capChannel;
const send = (label: string, frame: Uint8Array) => {
  log(`-> ${label}: ch=0x${(frame[2]! << 8 | frame[3]!).toString(16)}`);
  channel.write(session.encryptFrame(frame));
};

// Experiment steps. Each waits ~2 s so replies land against the step that caused them.
async function experiments() {
  const streamCtl = (id: number, on?: boolean) =>
    concat(BandWire.field(1, id), BandWire.field(4, on === undefined ? new Uint8Array() : concat(
      BandWire.field(3, on ? 1 : 0), BandWire.field(6, on ? 1 : 0), BandWire.field(8, on ? 1 : 0))));

  log("== step 1: baseline subscribe (expect 0xc001)");
  send("subscribe id2", BandWire.frame(0x8005, [0x8100ce56, 0x02000314], streamCtl(2)));
  await Bun.sleep(2500);

  log("== step 2: echo the band's 0x01000000 link message, then subscribe");
  send("echo 0x01000000", BandWire.frame(0x8001, [0x01000000]));
  await Bun.sleep(1500);
  send("subscribe id3 on", BandWire.frame(0x8005, [], streamCtl(3, true)));
  await Bun.sleep(2500);

  log("== step 3: resend EndLinkSetup, then subscribe on a fresh channel");
  send("EndLinkSetup", BandWire.frame(0x8001, [0x02001000], concat(BandWire.field(1, 1), BandWire.field(2, crypto.getRandomValues(new Uint8Array(16))))));
  await Bun.sleep(1500);
  send("subscribe id4 fresh 0x8009", BandWire.frame(0x8009, [0x8100ce56, 0x02000314], streamCtl(4)));
  await Bun.sleep(2500);

  log("== step 4: link-setup-config (type 0x02000003) then subscribe");
  send("linkSetupConfig", BandWire.frame(0x8001, [0x02000003], concat(BandWire.field(1, 1))));
  await Bun.sleep(1500);
  send("subscribe id5", BandWire.frame(0x8005, [], streamCtl(5)));
  await Bun.sleep(2500);

  log(`== done. authPkts=${session.authenticatedPackets} streams=${session.streamsEnabled}`);
  channel.close();
}

channel = new L2capChannel({
  onOpen: () => { log("l2cap open; handshake"); channel.write(session.request()); },
  onData: (bytes) => {
    const r = session.feed(bytes, Number(Bun.nanoseconds()) / 1e9);
    for (const p of r.packets) channel.write(p);
    if (!handshakeDone && session.authenticatedPackets > 0) {
      handshakeDone = true;
      setTimeout(() => void experiments(), 1200);
    }
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"}`); process.exit(0); },
  onLog: (m) => log(`  ${m}`),
});
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: "low" });
setTimeout(() => { log("overall timeout"); channel.close(); }, 60000);
