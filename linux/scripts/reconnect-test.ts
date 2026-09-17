// Does the band re-advertise / accept a reconnect on its own after it resets a session,
// or does it go dormant until a button press? Recipe: connect, stream, and the instant the
// band drops the link, purge its BlueZ object and watch a continuous scan for 120 s WITHOUT
// any button press, logging every fresh advertisement and every reconnect attempt.
//
//   bun run scripts/reconnect-test.ts     (press the button once to start the first session)
import * as bluez from "../src/bluez";
import { L2capChannel } from "../src/l2cap";
import { BandSession } from "../src/session";
import { loadConfig } from "../src/config";

const config = await loadConfig();
const band = config.band!;
const t0 = Date.now();
const log = (m: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);


async function findLiveBand(): Promise<{ path: string; address: string; type: "public" | "random"; rssi: number } | undefined> {
  for (const [path, ifaces] of await bluez.objects()) {
    const d = ifaces.get("org.bluez.Device1");
    if (!d) continue;
    const name = String(d.get("Name") ?? d.get("Alias") ?? "");
    const rssi = d.get("RSSI");
    if (name.toLowerCase().startsWith("meta band") && typeof rssi === "number") {
      return { path, address: String(d.get("Address")), type: d.get("AddressType") === "random" ? "random" : "public", rssi };
    }
  }
  return undefined;
}

async function purgeBands(): Promise<void> {
  const adapter = await bluez.adapterPath();
  for (const [path, ifaces] of await bluez.objects()) {
    const d = ifaces.get("org.bluez.Device1");
    const name = d && String(d.get("Name") ?? d.get("Alias") ?? "");
    if (name && name.toLowerCase().startsWith("meta band")) {
      await bluez.removeDeviceByPath(adapter, path).catch(() => {});
    }
  }
}

// ---- Phase 1: get a streaming session (needs one button press) ----
log("Phase 1: put the band in pairing mode (press the button). Waiting for it to advertise…");
const found = await bluez.discoverBand(band, 120);
if (!found) { console.error("Band never advertised."); process.exit(1); }
log(`found ${found.device.address} (${found.device.addressType}); connecting`);
const session = new BandSession({ configChannel: config.configChannel });
let streamed = false;
await new Promise<void>((resolve) => {
  const ch = new L2capChannel({
    onOpen: () => ch.write(session.request()),
    onData: (bytes) => {
      const r = session.feed(bytes, Number(Bun.nanoseconds()) / 1e9);
      for (const p of r.packets) ch.write(p);
      if (r.events.some((e) => e.payload.type === "connected")) { streamed = true; log("*** streaming ***"); }
    },
    onClose: (reason) => { log(`session ended: ${reason ?? "closed"}  (streamed=${streamed})`); resolve(); },
    onLog: (m) => {},
  });
  ch.open({ address: found.device.address, addressType: found.device.addressType, psm: config.psm, security: "low" });
});

// ---- Phase 2: after the reset, watch for self-re-advertisement, no button press ----
const resetAt = Date.now();
log("Phase 2: band reset. DO NOT press the button. Watching 120 s for it to re-advertise on its own…");
await purgeBands();
bluez.holdDiscovery(130);
let firstSeen: number | undefined;
let reconnected = false;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !reconnected) {
  await Bun.sleep(2000);
  const live = await findLiveBand();
  if (!live) { log(`  ${((Date.now() - resetAt) / 1000).toFixed(0)}s: silent (no advertisement)`); continue; }
  if (firstSeen === undefined) { firstSeen = Date.now(); log(`  RE-ADVERTISED after ${((firstSeen - resetAt) / 1000).toFixed(1)}s at rssi ${live.rssi} — trying to reconnect`); }
  await bluez.releaseDiscovery();
  const s2 = new BandSession({ configChannel: config.configChannel });
  reconnected = await new Promise<boolean>((resolve) => {
    let ok = false;
    const ch = new L2capChannel({
      onOpen: () => ch.write(s2.request()),
      onData: (bytes) => { const r = s2.feed(bytes, Number(Bun.nanoseconds()) / 1e9); for (const p of r.packets) ch.write(p); if (r.events.some((e) => e.payload.type === "connected")) { ok = true; log("*** RECONNECTED and streaming, no button press ***"); ch.close(); } },
      onClose: () => resolve(ok),
      onLog: () => {},
    });
    ch.open({ address: live.address, addressType: live.type, psm: config.psm, security: "low", connectTimeoutMs: 8000 });
    setTimeout(() => { if (!ok) ch.close(); }, 12000);
  });
  if (!reconnected) { log(`  reconnect attempt failed; keep watching`); bluez.holdDiscovery(130); }
}
await bluez.releaseDiscovery();
log(`RESULT: re-advertised=${firstSeen !== undefined} reconnected_without_button=${reconnected}`);
process.exit(0);
