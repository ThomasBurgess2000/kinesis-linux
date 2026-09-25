// Passive probe: complete the AirShield handshake by hand (param-26 derivation), then send NOTHING
// and decrypt+dump every frame the band pushes on its own. Reveals the full band-initiated sequence
// (the service-0x4f RequestEncryption, the EnableTrustEC proof, capabilities) with plaintext.
import { createECDH, randomBytes } from "node:crypto";
import { AirShieldKeys, AirShieldReceiver, AirShieldCipher, airShieldParams, macPrefixFor } from "../src/airshield";
import * as bluez from "../src/bluez";
import { loadConfig } from "../src/config";
import { L2capChannel } from "../src/l2cap";
import { BandWire, ProtoFields, DataXReceiver, be16, be32, concat, hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band!;

let found: { path: string; device: { address: string; addressType: "public" | "random" } } | undefined;
let psm = 0;
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

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const ourPub = new Uint8Array(ecdh.getPublicKey()).subarray(1);
const ourChallenge = new Uint8Array(randomBytes(16));
const ourSeed = new Uint8Array(randomBytes(32));
const ourIV = new Uint8Array(randomBytes(16));
const ourBase = randomBytes(4).readUInt32LE(0);

let pending = new Uint8Array();
let receiver: AirShieldReceiver | undefined;
const datax = new DataXReceiver();
function drain(bytes: Uint8Array) {
  log(`  raw ${bytes.length}B: ${hex(bytes.subarray(0, 24))}${bytes.length > 24 ? "…" : ""}`);
  try {
    for (const plain of receiver!.feed(bytes)) {
      for (const f of datax.feed(plain)) {
        const svc = f.words.length ? (f.words[0]! & 0xff) : -1;
        log(`  FRAME ch=0x${f.channel.toString(16)} svc=0x${svc.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}] payload=${hex(f.payload)}`);
      }
    }
  } catch (e) { log(`  decrypt error: ${e instanceof Error ? e.message : e}`); }
}

const channel: L2capChannel = new L2capChannel({
  onOpen: () => {
    log("l2cap open; sending RequestEncryption (offer 31), then going passive");
    channel.write(BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, ourPub), BandWire.field(2, ourChallenge), BandWire.field(3, 0), BandWire.field(4, 31), BandWire.field(7, 16))));
  },
  onData: (bytes) => {
    if (receiver) { drain(bytes); return; }
    pending = concat(pending, bytes);
    while (!receiver && pending.length >= 4) {
      const size = (be16(pending, 0) & 0x7fff) + 4;
      if (pending.length < size) break;
      const frame = pending.slice(0, size); pending = pending.slice(size);
      const offset = frame[2]! & 0x80 ? 8 : 4;
      const kind = be32(frame, offset);
      const fields = new ProtoFields(frame.subarray(offset + 4));
      const point = fields.bytes(1, 64);
      if (kind === 0x02000001) {
        const bandChallenge = fields.bytes(2, 16); const offered = fields.integer(4);
        log(`  band pubkey; offered params ${offered}`);
        const secret = new Uint8Array(ecdh.computeSecret(concat(new Uint8Array([4]), point)));
        (globalThis as any)._sc = { secret, bandChallenge, point };
        channel.write(BandWire.frame(1, [0x02000002], concat(
          BandWire.field(1, ourPub), BandWire.field(2, ourSeed), BandWire.field(3, ourIV), BandWire.field(4, ourBase), BandWire.field(5, 3))));
      } else if (kind === 0x02000002) {
        const negotiated = fields.integer(5);
        const sc = (globalThis as any)._sc;
        const bandSeed = fields.bytes(2, 32); const bandIV = fields.bytes(3, 16); const bandBase = Number(fields.integer(4));
        const p = airShieldParams(negotiated); const mp = macPrefixFor(negotiated);
        log(`  handshake done; negotiated ${negotiated}; going passive, decrypting band frames`);
        receiver = new AirShieldReceiver(new AirShieldCipher(
          AirShieldKeys.derive(sc.secret, ourChallenge, bandSeed, p), bandIV, bandBase, mp));
        if (pending.length) { const rest = pending; pending = new Uint8Array(); drain(rest); }
      }
    }
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"}`); process.exit(0); },
  onLog: (m) => log(`  l2cap: ${m}`),
});
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: "low" });
setTimeout(() => { log("30s window elapsed"); channel.close(); }, 30000);
