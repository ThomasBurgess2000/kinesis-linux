// Capture one AirShield handshake plus the band's first encrypted record, so the key
// derivation for this band's parameter set can be brute-forced offline (scripts/params-solve.ts).
// Does the handshake by hand (own ECDH) to capture the shared secret and all material.
import { createECDH, randomBytes } from "node:crypto";
import * as bluez from "../src/bluez";
import { loadConfig } from "../src/config";
import { L2capChannel } from "../src/l2cap";
import { BandWire, ProtoFields, be16, be32, concat, hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band!;
const SB = process.env.PROBE_OUT ?? "/tmp/claude-1000/-home-thomas-kinesis/9a166f08-6563-4138-a1a2-61a809cc98de/scratchpad/params.json";

let found: { path: string; device: { address: string; addressType: "public" | "random" } } | undefined;
let psm = 0;
for (let attempt = 1; attempt <= 10 && psm === 0; attempt++) {
  found = await bluez.discoverBand(band, 60);
  if (!found) { console.error("band not advertising"); process.exit(1); }
  try {
    await bluez.connect(found.path, 18);
    const char = await bluez.characteristicPath(found.path, bluez.PSM_CHARACTERISTIC);
    if (!char) throw new Error("no PSM characteristic");
    const psmVal = await bluez.readCharacteristic(char);
    psm = psmVal[0]! | (psmVal[1]! << 8);
  } catch (e) {
    log(`connect attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`);
    await bluez.disconnect(found.path).catch(() => {});
    await Bun.sleep(1500);
  }
}
if (!found || psm === 0) { console.error("could not connect"); process.exit(1); }
// After the BlueZ connect the band is on its identity address; open L2CAP to that, not the RPA.
const resolved = (await bluez.deviceByPath(found.path)) ?? found.device;
log(`connected ${resolved.address} (${resolved.addressType}) psm=${psm}`);

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const ourPub = new Uint8Array(ecdh.getPublicKey()).subarray(1);
const ourChallenge = new Uint8Array(randomBytes(16));
const ourSeed = new Uint8Array(randomBytes(32));
const ourIV = new Uint8Array(randomBytes(16));
const ourBase = randomBytes(4).readUInt32LE(0);

let pending = new Uint8Array();
let setupDone = false;
let bandPub: Uint8Array | undefined, bandChallenge: Uint8Array | undefined;
let secret: Uint8Array | undefined, bandSeed: Uint8Array | undefined, bandIV: Uint8Array | undefined, bandBase = 0;
let firstRecord = new Uint8Array();
let offered = 0n, negotiated = 0n;

const channel: L2capChannel = new L2capChannel({
  onOpen: () => {
    log("l2cap open; sending RequestEncryption");
    const req = BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, ourPub), BandWire.field(2, ourChallenge), BandWire.field(3, 0), BandWire.field(4, 31), BandWire.field(7, 16)));
    channel.write(req);
  },
  onData: (bytes) => {
    if (!setupDone) log(`  in ${bytes.length}B: ${hex(bytes.subarray(0, 8))}…`);
    pending = concat(pending, bytes);
    while (!setupDone && pending.length >= 4) {
      const size = (be16(pending, 0) & 0x7fff) + 4;
      if (pending.length < size) break;
      const frame = pending.slice(0, size);
      pending = pending.slice(size);
      const offset = frame[2]! & 0x80 ? 8 : 4;
      const kind = be32(frame, offset);
      const fields = new ProtoFields(frame.subarray(offset + 4));
      log(`  setup frame kind=0x${kind.toString(16)} ch=0x${be16(frame, 2).toString(16)} size=${size}`);
      const point = fields.bytes(1, 64);
      if (kind === 0x02000001) {
        bandPub = point; bandChallenge = fields.bytes(2, 16); offered = fields.integer(4);
        secret = new Uint8Array(ecdh.computeSecret(Buffer.from(concat(new Uint8Array([4]), point))));
        channel.write(BandWire.frame(1, [0x02000002], concat(
          BandWire.field(1, ourPub), BandWire.field(2, ourSeed), BandWire.field(3, ourIV), BandWire.field(4, ourBase), BandWire.field(5, 3))));
      } else if (kind === 0x02000002) {
        bandSeed = fields.bytes(2, 32); bandIV = fields.bytes(3, 16); bandBase = Number(fields.integer(4)); negotiated = fields.integer(5);
        setupDone = true;
      }
    }
    if (setupDone) {
      firstRecord = concat(firstRecord, pending);
      pending = new Uint8Array();
      if (firstRecord.length >= 40) finish();
    }
  },
  onClose: (reason) => { log(`l2cap closed: ${reason ?? "ok"}`); finish(); },
  onLog: (m) => log(`  l2cap: ${m}`),
});

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  if (!secret || !bandChallenge || !bandSeed || !bandIV || !bandPub) { log("handshake incomplete"); process.exit(1); }
  const out = {
    offered: offered.toString(), negotiated: negotiated.toString(),
    secret: hex(secret), ourChallenge: hex(ourChallenge), ourSeed: hex(ourSeed), ourIV: hex(ourIV), ourBase,
    bandChallenge: hex(bandChallenge), bandSeed: hex(bandSeed), bandIV: hex(bandIV), bandBase, bandPub: hex(bandPub),
    firstRecord: hex(firstRecord),
  };
  await Bun.write(SB, JSON.stringify(out, null, 2));
  log(`offered ${offered} negotiated ${negotiated}; captured ${firstRecord.length}B first record -> ${SB}`);
  channel.close();
  process.exit(0);
}
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: "low" });
setTimeout(() => finish(), 15000);
