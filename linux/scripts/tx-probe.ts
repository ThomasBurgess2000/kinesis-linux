// Isolate whether our param-26 TX (encrypt to band) is accepted. Handshake by hand, build BOTH
// ciphers with the negotiated params, then send ONE encrypted identity-read frame (0x8002 identity
// service open) and watch: a band response = TX MAC good; an immediate close = TX MAC rejected.
import { createECDH, randomBytes } from "node:crypto";
import { AirShieldKeys, AirShieldReceiver, AirShieldCipher, airShieldParams, macPrefixFor } from "../src/airshield";
import * as bluez from "../src/bluez";
import { loadConfig } from "../src/config";
import { L2capChannel } from "../src/l2cap";
import { BandWire, ProtoFields, DataXReceiver, be16, be32, concat, hex } from "../src/wire";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const config = await loadConfig();
const band = config.band!;
// PROBE_BOND=1: SMP-pair the link and open L2CAP encrypted, as macOS always does.
const BOND = process.env.PROBE_BOND === "1";
// PROBE_WAIT_BOND=1: handshake unbonded, then hold the session until someone pairs the band by
// hand (e.g. in system Bluetooth settings), and only then send the encrypted frame.
const WAIT_BOND = process.env.PROBE_WAIT_BOND === "1";
// The parameters we declare in our EnableEncryption (field 5) and therefore send with.
const OUR_PARAMS = BigInt(process.env.PROBE_TX_PARAMS ?? "3");
async function waitForBond(path: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const state = await bluez.deviceState(path).catch(() => undefined);
    if (state?.paired) return true;
    await Bun.sleep(500);
  }
  return false;
}

let found: { path: string; device: { address: string; addressType: "public" | "random" } } | undefined;
let psm = 0;
for (let a = 1; a <= 12 && psm === 0; a++) {
  found = await bluez.discoverBand(band, 60);
  if (!found) { console.error("not advertising"); process.exit(1); }
  try {
    await bluez.connect(found.path, 18);
    if (BOND) {
      log("bonding through BlueZ (SMP pairing)…");
      await bluez.pair(found.path);
      log(`bonded: ${JSON.stringify(await bluez.deviceState(found.path))}`);
    }
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
let tx: AirShieldCipher | undefined;
let sentIdentityRead = false;
const datax = new DataXReceiver();

function drain(bytes: Uint8Array) {
  log(`  raw ${bytes.length}B: ${hex(bytes.subarray(0, 20))}${bytes.length > 20 ? "…" : ""}`);
  try {
    for (const plain of receiver!.feed(bytes)) {
      for (const f of datax.feed(plain)) {
        log(`  FRAME ch=0x${f.channel.toString(16)} words=[${f.words.map((w) => "0x" + w.toString(16)).join(",")}] payload=${hex(f.payload)}`);
      }
    }
  } catch (e) { log(`  decrypt error: ${e instanceof Error ? e.message : e}`); }
}

const channel: L2capChannel = new L2capChannel({
  onOpen: () => {
    log("l2cap open; RequestEncryption (offer 31)");
    channel.write(BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, ourPub), BandWire.field(2, ourChallenge), BandWire.field(3, 0), BandWire.field(4, 31), BandWire.field(7, 16))));
  },
  onData: (bytes) => {
    if (receiver) {
      drain(bytes);
      if (tx && !sentIdentityRead) {
        sentIdentityRead = true;
        const frame = BandWire.frame(0x8002, [0x81000024, 0x02003000]);
        log(`  -> encrypted identity read on 0x8002 (counter=${tx.counter})`);
        channel.write(tx.encrypt(frame));
      }
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
        const offered = fields.integer(4);
        log(`  band pubkey; offered ${offered}`);
        (globalThis as any)._sc = { secret: new Uint8Array(ecdh.computeSecret(concat(new Uint8Array([4]), point))), bandChallenge: fields.bytes(2, 16) };
        channel.write(BandWire.frame(1, [0x02000002], concat(
          BandWire.field(1, ourPub), BandWire.field(2, ourSeed), BandWire.field(3, ourIV), BandWire.field(4, ourBase), BandWire.field(5, Number(OUR_PARAMS)))));
      } else if (kind === 0x02000002) {
        const negotiated = fields.integer(5);
        const sc = (globalThis as any)._sc;
        const bandSeed = fields.bytes(2, 32); const bandIV = fields.bytes(3, 16); const bandBase = Number(fields.integer(4));
        const p = airShieldParams(negotiated); const mp = macPrefixFor(negotiated);
        log(`  handshake done; negotiated ${negotiated}. TX salt=SHA256(bandChallenge||ourSeed), prefix=${hex(mp)}`);
        // NOTE: TX uses the BAND's challenge; we didn't capture it above, capture it now from _sc? we need bandChallenge.
        receiver = new AirShieldReceiver(new AirShieldCipher(
          AirShieldKeys.derive(sc.secret, ourChallenge, bandSeed, p), bandIV, bandBase, mp));
        // Each side sends with the parameters it declared in its own EnableEncryption field 5.
        tx = new AirShieldCipher(AirShieldKeys.derive(sc.secret, sc.bandChallenge, ourSeed, airShieldParams(OUR_PARAMS)), ourIV, ourBase, macPrefixFor(OUR_PARAMS));
        log(`  TX uses our declared params ${OUR_PARAMS}; RX uses the band's ${negotiated}`);
        if (pending.length) { const rest = pending; pending = new Uint8Array(); drain(rest); }
        // Proactively send one encrypted identity-read; the band is silent after the handshake.
        const send = () => {
          sentIdentityRead = true;
          log(`  -> encrypted identity read on 0x8002 (counter=${tx!.counter})`);
          channel.write(tx!.encrypt(BandWire.frame(0x8002, [0x81000024, 0x02003000])));
        };
        if (WAIT_BOND) {
          log("  handshake held open: PAIR THE BAND IN BLUETOOTH SETTINGS NOW (waiting up to 40s)");
          void waitForBond(found!.path, 40).then(async (paired) => {
            log(paired ? `  band is paired: ${JSON.stringify(await bluez.deviceState(found!.path).catch(() => "?"))}` : "  no pairing within 40s; sending anyway");
            send();
          });
        } else {
          send();
        }
      }
    }
  },
  onClose: (reason) => { log(`closed: ${reason ?? "ok"} (sentIdentityRead=${sentIdentityRead})`); process.exit(0); },
  onLog: (m) => log(`  l2cap: ${m}`),
});
channel.open({ address: resolved.address, addressType: resolved.addressType, psm, security: BOND ? "medium" : "low" });
setTimeout(() => { log("window elapsed"); channel.close(); }, WAIT_BOND ? 60000 : 25000);
