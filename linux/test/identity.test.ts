import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BandIdentity, SigningKey, verifyPreimage } from "../src/identity";

test("a signing key round-trips through its raw scalar and yields a 64-byte point", () => {
  const key = SigningKey.generate();
  expect(key.privateRaw.length).toBe(32);
  expect(key.publicPoint.length).toBe(64);
  const same = SigningKey.fromRaw(key.privateRaw);
  expect(Buffer.compare(same.publicPoint, key.publicPoint)).toBe(0);
});

test("sign/verify over a digest preimage round-trips and rejects tampering", () => {
  const key = SigningKey.generate();
  const preimage = new Uint8Array(64).map((_, i) => (i * 7) & 0xff);
  const sig = key.signPreimage(preimage);
  expect(sig.length).toBe(64);
  expect(verifyPreimage(key.publicPoint, preimage, sig)).toBe(true);

  const other = SigningKey.generate();
  expect(verifyPreimage(other.publicPoint, preimage, sig)).toBe(false);
  const tampered = preimage.slice();
  tampered[0]! ^= 1;
  expect(verifyPreimage(key.publicPoint, tampered, sig)).toBe(false);
  const badSig = sig.slice();
  badSig[10]! ^= 1;
  expect(verifyPreimage(key.publicPoint, preimage, badSig)).toBe(false);
});

test("parses a band-identity-record.json and matches the private key to its public point", () => {
  const app = SigningKey.generate();
  const band = SigningKey.generate();
  const record = {
    AppPrivateKey: Buffer.from(app.privateRaw).toString("base64"),
    AppPublicKey: Buffer.from(app.publicPoint).toString("base64"),
    AppECPublicKey: Buffer.from(band.publicPoint).toString("base64"),
  };
  const identity = BandIdentity.record(new Uint8Array(Buffer.from(JSON.stringify(record), "utf8")));
  expect(Buffer.compare(identity.privateKey.privateRaw, app.privateRaw)).toBe(0);
  expect(identity.bandPublicKey && Buffer.compare(identity.bandPublicKey, band.publicPoint)).toBe(0);

  // A mismatched public key is rejected.
  const bad = { ...record, AppPublicKey: Buffer.from(band.publicPoint).toString("base64") };
  expect(() => BandIdentity.record(new Uint8Array(Buffer.from(JSON.stringify(bad), "utf8")))).toThrow();
});

test("save/enrollment/remove round-trip through a temp file", async () => {
  const dir = `${process.env.XDG_STATE_HOME ?? ""}`;
  const tmp = `/tmp/claude-1000/kinesis-identity-test-${crypto.randomUUID()}`;
  process.env.XDG_STATE_HOME = tmp;
  try {
    const key = SigningKey.generate();
    const band = SigningKey.generate();
    const address = "AA:BB:CC:DD:EE:FF";
    expect(await BandIdentity.exists(address)).toBe(false);
    await BandIdentity.save({ privateKey: key, bandPublicKey: band.publicPoint }, address);
    expect(await BandIdentity.exists(address)).toBe(true);
    const loaded = await BandIdentity.enrollment(address);
    expect(loaded).toBeDefined();
    expect(Buffer.compare(loaded!.privateKey.privateRaw, key.privateRaw)).toBe(0);
    expect(loaded!.bandPublicKey && Buffer.compare(loaded!.bandPublicKey, band.publicPoint)).toBe(0);
    await BandIdentity.remove(address);
    expect(await BandIdentity.exists(address)).toBe(false);
  } finally {
    process.env.XDG_STATE_HOME = dir;
  }
});

test("verifyPreimage matches an independent SHA-256 digest computation", () => {
  // Confirms sign hashes the preimage with SHA-256 before ECDSA (matches CryptoKit signature(for:)).
  const key = SigningKey.generate();
  const preimage = new Uint8Array([1, 2, 3, 4, 5]);
  const digest = createHash("sha256").update(preimage).digest();
  expect(digest.length).toBe(32);
  const sig = key.signPreimage(preimage);
  expect(verifyPreimage(key.publicPoint, preimage, sig)).toBe(true);
});
