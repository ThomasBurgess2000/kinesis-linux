// Run the enrolled trust handshake with a throwaway key and log the band's result word and any
// proof/extra frames. Tells us whether the band is unowned (accepts, 0x03001000) or enrolled to a
// key we don't have (0x03001043), and dumps whatever else it sends (e.g. the service-0x4f frames).
import * as bluez from "../src/bluez";
import { loadConfig } from "../src/config";
import { SigningKey } from "../src/identity";
import { L2capChannel } from "../src/l2cap";
import { BandSession } from "../src/session";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band!;

let found, psm = 0;
for (let a = 1; a <= 10 && psm === 0; a++) {
  found = await bluez.discoverBand(band, 60);
  if (!found) { console.error("not advertising"); process.exit(1); }
  try {
    await bluez.connect(found.path, 18);
    const psmVal = await bluez.readCharacteristic((await bluez.characteristicPath(found.path, bluez.PSM_CHARACTERISTIC))!);
    psm = psmVal[0]! | (psmVal[1]! << 8);
  } catch (e) { log(`connect ${a} failed: ${e instanceof Error ? e.message : e}`); await bluez.disconnect(found.path).catch(() => {}); await Bun.sleep(1500); }
}
if (!found || psm === 0) { console.error("no connect"); process.exit(1); }
const resolved = (await bluez.deviceByPath(found.path)) ?? found.device;
log(`connected ${resolved.address} psm=${psm}`);

// Enrolled startup with a throwaway key: sends EnableTrust; band answers with a result code.
const session = new BandSession({ enrollment: { privateKey: SigningKey.generate() } });
let n = 0;
session.onFrame = (f) => log(`  <- #${n++} ch=0x${f.channel.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}] len=${f.length}`);
const channel: L2capChannel = new L2capChannel({
  onOpen: () => { log("l2cap open; enrolled EnableTrust with a throwaway key"); channel.write(session.request()); },
  onData: (bytes) => {
    try {
      const r = session.feed(bytes, Number(Bun.nanoseconds()) / 1e9);
      for (const p of r.packets) channel.write(p);
      for (const e of r.events) log(`  event ${e.payload.type}`);
      if (r.events.some((e) => e.payload.type === "connected")) { log("*** trusted with a throwaway key: the band is UNOWNED ***"); channel.close(); }
    } catch (e) { log(`  feed error: ${e instanceof Error ? e.message : e}`); channel.close(); }
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"}`); process.exit(0); },
  onLog: (m) => log(`  ${m}`),
});
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: "low" });
setTimeout(() => { log("timeout"); channel.close(); }, 20000);
