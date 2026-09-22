// Offline: given a captured handshake + first encrypted record (scripts/params-probe.ts),
// search AirShield key-derivation / MAC-format variants for the one whose 8-byte MAC matches,
// then confirm it decrypts to a plausible DataX frame. Finds this band's parameter recipe.
import { createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { fromHex, hex } from "../src/wire";

const path = process.argv[2] ?? "/tmp/claude-1000/-home-thomas-kinesis/9a166f08-6563-4138-a1a2-61a809cc98de/scratchpad/params.json";
const d = JSON.parse(await Bun.file(path).text());
const secret = fromHex(d.secret), ourChallenge = fromHex(d.ourChallenge), bandSeed = fromHex(d.bandSeed);
const bandChallenge = fromHex(d.bandChallenge), ourSeed = fromHex(d.ourSeed);
const bandBase: number = d.bandBase;
const raw = fromHex(d.firstRecord);
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const cat = (...xs: Uint8Array[]) => { const n = xs.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string) => new Uint8Array(hkdfSync("sha256", ikm, salt, info, 32));
const le32 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

// Find the first 0x40 authenticated record, skipping 0x81/0x82 control and 0x01/0x02 relay framing.
let i = 0;
while (i < raw.length) {
  const m = raw[i]!;
  if ((m === 0x81 || m === 0x82) && raw[i + 1]! <= 1) { i += 2; continue; }
  if (m === 0x01 || m === 0x02) { i += 3 + raw[i + 1]!; continue; }
  break;
}
const rec = raw.subarray(i);
if (rec[0] !== 0x40) { console.error(`first record marker is 0x${rec[0]?.toString(16)}, not 0x40`); process.exit(1); }
const recMac = rec.subarray(1, 9);
const blocks = rec[9]! + 1;
const size = 10 + blocks * 16;
const body = rec.subarray(9, size);          // blockcount || ciphertext
const ciphertext = rec.subarray(10, size);
console.log(`record: ${blocks} block(s), body ${body.length}B, mac ${hex(recMac)}`);

// Key-derivation candidates for the RX direction (band -> us).
type Keys = { name: string; enc: Uint8Array; mac: Uint8Array };
function deriveCandidates(): Keys[] {
  const H = sha(secret);
  const out: Keys[] = [];
  // (challenge C, seed R) role assignments to try for RX.
  const roles: [string, Uint8Array, Uint8Array][] = [
    ["C=our,R=bandSeed", ourChallenge, bandSeed],
    ["C=band,R=ourSeed", bandChallenge, ourSeed],
  ];
  for (const [rn, C, R] of roles) {
    for (const [en, ikm, encSalt] of [
      [`encA`, H, sha(cat(H, C, R))],
      [`encA'`, H, sha(cat(C, R))],
      [`encB`, secret, sha(cat(C, R))],
      [`encB'`, secret, sha(cat(H, C, R))],
    ] as [string, Uint8Array, Uint8Array][]) {
      const enc = hkdf(ikm, encSalt, "AirShield");
      const macs: [string, Uint8Array][] = [
        ["mac=enc", enc],
        ["mac7", hkdf(ikm, sha(cat(R, C, new Uint8Array(Buffer.from("hmac_derive")))), "AirShield")],
        ["mac7H", hkdf(ikm, sha(cat(R, C, new Uint8Array(Buffer.from("hmac_derive")), H)), "AirShield")],
      ];
      for (const [mn, mac] of macs) out.push({ name: `${rn}|${en}|${mn}`, enc, mac });
    }
  }
  return out;
}

// MAC input formats to try.
const inputs: [string, (b: Uint8Array) => Uint8Array][] = [
  ["le32(base)||body", (b) => cat(le32(bandBase), b)],
  ["be32(base)||body", (b) => cat(be32(bandBase), b)],
  ["body", (b) => b],
  ["0202 0000||le32||body", (b) => cat(new Uint8Array([2, 2, 0, 0]), le32(bandBase), b)],
  ["0200 0000||le32||body", (b) => cat(new Uint8Array([2, 0, 0, 0]), le32(bandBase), b)],
  ["le32(base)||ciphertext", () => cat(le32(bandBase), ciphertext)],
];

let matched = false;
for (const k of deriveCandidates()) {
  for (const [inName, build] of inputs) {
    const mac = new Uint8Array(createHmac("sha256", k.mac).update(build(body)).digest()).subarray(0, 8);
    if (Buffer.compare(mac, recMac) === 0) {
      matched = true;
      console.log(`\n*** MAC MATCH: ${k.name} | input=${inName} ***`);
      // Decrypt with the band's IV (RX IV comes from the band's EnableEncryption).
      try {
        const cipher = createDecipheriv("aes-256-cbc", k.enc, fromHex(d.bandIV));
        cipher.setAutoPadding(false);
        const plain = new Uint8Array(Buffer.concat([cipher.update(Buffer.from(ciphertext)), cipher.final()]));
        console.log(`  decrypt(bandIV): ${hex(plain.subarray(0, 32))}…`);
      } catch (e) { console.log(`  decrypt failed: ${e}`); }
    }
  }
}
if (!matched) console.log("\nNo MAC match among the tried variants.");
