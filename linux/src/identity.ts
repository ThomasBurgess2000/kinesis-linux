// Persistent band-ownership identity. Port of Sources/KinesisCore/BandIdentity.swift,
// storing the enrolled P-256 signing key in a file instead of the macOS keychain.
//
// The private key signs the per-session EnableTrust proof; the optional band public
// key verifies the band's own EnableTrustEC proof. Key bytes never appear in logs.

import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BandProtocolError } from "./wire";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/// Left-pad (or verify) a big-endian scalar/coordinate to exactly 32 bytes.
function pad32(b: Uint8Array): Uint8Array {
  if (b.length === 32) return b;
  if (b.length > 32) return b.subarray(b.length - 32);
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

/// A P-256 signing key with its raw scalar and 64-byte public point (x||y, no 0x04 prefix).
export class SigningKey {
  private constructor(
    readonly privateRaw: Uint8Array,
    readonly publicPoint: Uint8Array,
    private readonly key: KeyObject,
  ) {}

  static generate(): SigningKey {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" }) as { d: string };
    return SigningKey.fromRaw(pad32(fromB64url(jwk.d)));
  }

  static fromRaw(scalar: Uint8Array): SigningKey {
    if (scalar.length !== 32) throw new BandProtocolError("A P-256 private key must be 32 bytes");
    // Derive the public point from the scalar via ECDH, then build a signing key object.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(scalar));
    const uncompressed = new Uint8Array(ecdh.getPublicKey()); // 0x04 || x || y
    const point = uncompressed.subarray(1);
    const key = createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: b64url(scalar), x: b64url(point.subarray(0, 32)), y: b64url(point.subarray(32, 64)) },
      format: "jwk",
    });
    return new SigningKey(scalar, point, key);
  }

  /// ECDSA-P256 over a message whose SHA-256 is the transcript digest, returning the raw
  /// 64-byte (r||s) signature the band expects. `crypto.sign("sha256", …)` hashes the
  /// preimage, matching CryptoKit's `signature(for: SHA256(preimage))`.
  signPreimage(preimage: Uint8Array): Uint8Array {
    return new Uint8Array(cryptoSign("sha256", preimage, { key: this.key, dsaEncoding: "ieee-p1363" }));
  }
}

const fromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

/// Verify a raw 64-byte ECDSA-P256 signature by a 64-byte public point over a digest preimage.
export function verifyPreimage(point: Uint8Array, preimage: Uint8Array, signature: Uint8Array): boolean {
  if (point.length !== 64 || signature.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(point.subarray(0, 32)), y: b64url(point.subarray(32, 64)) },
    format: "jwk",
  });
  return cryptoVerify("sha256", preimage, { key, dsaEncoding: "ieee-p1363" }, signature);
}

export interface BandEnrollmentIdentity {
  privateKey: SigningKey;
  bandPublicKey?: Uint8Array; // 64-byte point, when known
}

export class BandIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BandIdentityMismatchError";
  }
}

interface StoredIdentity {
  appPrivateKey: string; // base64, 32 bytes
  bandPublicKey?: string; // base64, 64 bytes
}

/// One JSON file per band under the identity directory.
export const BandIdentity = {
  path(band: string): string {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(base, "kinesis", "identity", `${band.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  },

  async enrollment(band: string): Promise<BandEnrollmentIdentity | undefined> {
    const file = Bun.file(BandIdentity.path(band));
    if (!(await file.exists())) return undefined;
    let stored: StoredIdentity;
    try {
      stored = (await file.json()) as StoredIdentity;
    } catch {
      return undefined;
    }
    const raw = fromB64(stored.appPrivateKey);
    if (raw.length !== 32) return undefined;
    const bandPublicKey = stored.bandPublicKey ? fromB64(stored.bandPublicKey) : undefined;
    return {
      privateKey: SigningKey.fromRaw(raw),
      ...(bandPublicKey && bandPublicKey.length === 64 ? { bandPublicKey } : {}),
    };
  },

  async exists(band: string): Promise<boolean> {
    return Bun.file(BandIdentity.path(band)).exists();
  },

  async save(identity: BandEnrollmentIdentity, band: string): Promise<void> {
    const path = BandIdentity.path(band);
    await mkdir(dirname(path), { recursive: true });
    const stored: StoredIdentity = {
      appPrivateKey: b64(identity.privateKey.privateRaw),
      ...(identity.bandPublicKey ? { bandPublicKey: b64(identity.bandPublicKey) } : {}),
    };
    await Bun.write(path, JSON.stringify(stored, null, 2) + "\n");
  },

  async remove(band: string): Promise<void> {
    await Bun.file(BandIdentity.path(band)).delete().catch(() => {});
  },

  /// Parse a recovered `band-identity-record.json`: the private and public app keys must
  /// match, and the record must carry the band's public key. Mirrors the reference workflow.
  record(json: Uint8Array): BandEnrollmentIdentity {
    let fields: { AppPrivateKey?: string; AppPublicKey?: string; AppECPubicKey?: string; AppECPublicKey?: string };
    try {
      fields = JSON.parse(Buffer.from(json).toString("utf8"));
    } catch {
      throw new BandProtocolError("the identity record is not valid json");
    }
    const raw = fields.AppPrivateKey ? fromB64(fields.AppPrivateKey) : new Uint8Array();
    if (raw.length !== 32) throw new BandProtocolError("the identity record holds no usable private key");
    const privateKey = SigningKey.fromRaw(raw);
    const pub = fields.AppPublicKey ? fromB64(fields.AppPublicKey) : new Uint8Array();
    if (pub.length !== 64 || Buffer.compare(pub, privateKey.publicPoint) !== 0) {
      throw new BandProtocolError("the identity record public key does not match its private key");
    }
    const bandField = fields.AppECPubicKey ?? fields.AppECPublicKey;
    const bandPublicKey = bandField ? fromB64(bandField) : new Uint8Array();
    if (bandPublicKey.length !== 64) throw new BandProtocolError("the identity record has no band public key");
    return { privateKey, bandPublicKey };
  },
};
