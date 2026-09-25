// Online solver for the param-26 TX (us->band) recipe. RX is known-good; TX is rejected. For each
// candidate (key salt role, MAC prefix, counter base) we open a fresh connection, do the handshake,
// send ONE encrypted identity-read, and record whether the band RESPONDS (accept) or drops the link
// (reject). The band stays advertising across reconnects, so one button press covers all candidates.
import { createECDH, createHash, randomBytes, hkdfSync } from "node:crypto";
import { AirShieldReceiver, AirShieldCipher } from "../src/airshield";
import * as bluez from "../src/bluez";
import { loadConfig } from "../src/config";
import { L2capChannel } from "../src/l2cap";
import { AirShieldKeys } from "../src/airshield";
import { BandWire, ProtoFields, DataXReceiver, be16, be32, concat, hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hkdf = (ikm: Uint8Array, salt: Uint8Array) => new Uint8Array(hkdfSync("sha256", ikm, salt, "AirShield", 32));
const config = await loadConfig();
const band = config.band!;

// Candidate TX recipes, ordered by likelihood. saltRole: which (challenge, seed) build the salt.
// prefix: MAC input prefix. base: 'our' | 'band' counter start.
type Cand = { name: string; saltRole: "swap" | "shared" | "senderChal"; prefix: number[]; base: "our" | "band" };
const CANDIDATES: Cand[] = [
  { name: "shared-key (C=our,R=band) prefix0202 our", saltRole: "shared", prefix: [2, 2, 0, 0], base: "our" },
  { name: "swap (C=band,R=our) prefix0202 our [current]", saltRole: "swap", prefix: [2, 2, 0, 0], base: "our" },
  { name: "senderChal (C=band,R=band) prefix0202 our", saltRole: "senderChal", prefix: [2, 2, 0, 0], base: "our" },
  { name: "shared-key prefix0102 our", saltRole: "shared", prefix: [1, 2, 0, 0], base: "our" },
  { name: "swap prefix0102 our", saltRole: "swap", prefix: [1, 2, 0, 0], base: "our" },
  { name: "shared-key noprefix our", saltRole: "shared", prefix: [], base: "our" },
  { name: "swap noprefix our", saltRole: "swap", prefix: [], base: "our" },
  { name: "shared-key prefix0202 band", saltRole: "shared", prefix: [2, 2, 0, 0], base: "band" },
];

async function connectOnce(): Promise<{ address: string; addressType: "public" | "random"; psm: number } | undefined> {
  for (let a = 1; a <= 8; a++) {
    const found = await bluez.discoverBand(band, 30);
    if (!found) { log("  not advertising"); await Bun.sleep(1000); continue; }
    try {
      await bluez.connect(found.path, 18);
      const psmVal = await bluez.readCharacteristic((await bluez.characteristicPath(found.path, bluez.PSM_CHARACTERISTIC))!);
      const psm = psmVal[0]! | (psmVal[1]! << 8);
      const resolved = (await bluez.deviceByPath(found.path)) ?? found.device;
      return { address: resolved.address, addressType: resolved.addressType, psm };
    } catch (e) { log(`  connect ${a}: ${e instanceof Error ? e.message : e}`); await bluez.disconnect(found.path).catch(() => {}); await Bun.sleep(1200); }
  }
  return undefined;
}

// Returns "accept" | "reject" | "nohandshake".
function tryCandidate(dev: { address: string; addressType: "public" | "random"; psm: number }, c: Cand): Promise<string> {
  return new Promise((resolve) => {
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const ourPub = new Uint8Array(ecdh.getPublicKey()).subarray(1);
    const ourChallenge = new Uint8Array(randomBytes(16));
    const ourSeed = new Uint8Array(randomBytes(32));
    const ourIV = new Uint8Array(randomBytes(16));
    const ourBase = randomBytes(4).readUInt32LE(0);
    let pending = new Uint8Array();
    let receiver: AirShieldReceiver | undefined;
    const datax = new DataXReceiver();
    let sc: { secret: Uint8Array; bandChallenge: Uint8Array } | undefined;
    let sent = false, gotResponse = false, done = false;
    const finish = (r: string) => { if (done) return; done = true; try { channel.close(); } catch {} resolve(gotResponse ? "accept" : r); };

    const channel: L2capChannel = new L2capChannel({
      onOpen: () => channel.write(BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
        BandWire.field(1, ourPub), BandWire.field(2, ourChallenge), BandWire.field(3, 0), BandWire.field(4, 31), BandWire.field(7, 16)))),
      onData: (bytes) => {
        if (receiver) {
          try { for (const p of receiver.feed(bytes)) for (const f of datax.feed(p)) { gotResponse = true; log(`    <- FRAME ch=0x${f.channel.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}]`); } }
          catch (e) { log(`    decrypt err: ${e instanceof Error ? e.message : e}`); }
          if (gotResponse) finish("accept");
          return;
        }
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
            sc = { secret: new Uint8Array(ecdh.computeSecret(concat(new Uint8Array([4]), point))), bandChallenge: fields.bytes(2, 16) };
            channel.write(BandWire.frame(1, [0x02000002], concat(
              BandWire.field(1, ourPub), BandWire.field(2, ourSeed), BandWire.field(3, ourIV), BandWire.field(4, ourBase), BandWire.field(5, 3))));
          } else if (kind === 0x02000002 && sc) {
            const bandSeed = fields.bytes(2, 32); const bandIV = fields.bytes(3, 16); const bandBase = Number(fields.integer(4));
            // RX (known-good): C=our, R=bandSeed.
            const rxSalt = sha(concat(ourChallenge, bandSeed));
            const rxKey = hkdf(sc.secret, rxSalt);
            receiver = new AirShieldReceiver(new AirShieldCipher(AirShieldKeys.fixed(rxKey, rxKey), bandIV, bandBase, new Uint8Array([2, 2, 0, 0])));
            // TX candidate.
            const [C, R] = c.saltRole === "swap" ? [sc.bandChallenge, ourSeed]
              : c.saltRole === "shared" ? [ourChallenge, bandSeed]
              : [sc.bandChallenge, bandSeed];
            const txKey = hkdf(sc.secret, sha(concat(C, R)));
            const txBase = c.base === "our" ? ourBase : bandBase;
            const tx = new AirShieldCipher(AirShieldKeys.fixed(txKey, txKey), ourIV, txBase, new Uint8Array(c.prefix));
            sent = true;
            channel.write(tx.encrypt(BandWire.frame(0x8002, [0x81000024, 0x02003000])));
          }
        }
      },
      onClose: () => finish(sent ? "reject" : "nohandshake"),
      onLog: () => {},
    });
    channel.open({ address: dev.address, addressType: dev.addressType, psm: dev.psm, security: "low" });
    setTimeout(() => finish(sent ? (gotResponse ? "accept" : "reject-timeout") : "nohandshake"), 8000);
  });
}

for (const c of CANDIDATES) {
  log(`candidate: ${c.name}`);
  const dev = await connectOnce();
  if (!dev) { log("  could not connect; is the band advertising? stopping."); break; }
  const result = await tryCandidate(dev, c);
  log(`  => ${result}`);
  await bluez.disconnect((await bluez.discoverBand(band, 3))?.path ?? "").catch(() => {});
  if (result === "accept") { log(`\n*** TX RECIPE FOUND: ${c.name} ***`); break; }
  await Bun.sleep(1500);
}
process.exit(0);
