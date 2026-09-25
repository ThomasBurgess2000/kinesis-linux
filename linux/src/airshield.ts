// AirShield transport crypto: P-256 ECDH secret -> HKDF keys, AES-256-CBC with
// chained IVs, and a truncated HMAC-SHA256 checked before any plaintext is released.
// Port of Sources/KinesisCore/AirShield.swift (parameter-3 branch only).

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { BandProtocolError, concat, equalBytes, u32le } from "./wire";

/// The parameter-dependent knobs of AirShield, decoded from the negotiated parameter bits.
export interface AirShieldParams {
  /// Raw-secret key derivation (param bits 3/4). Off = param-3 SHA256(secret) derivation.
  extended?: boolean;
  /// Separate HMAC key derivation (param bit 2). Off = MAC key equals the encryption key.
  separateMac?: boolean;
}

/// Decode the AirShield knobs from a negotiated parameter value.
export function airShieldParams(params: bigint): AirShieldParams {
  return { extended: (params & 0x18n) !== 0n, separateMac: (params & 0x4n) !== 0n };
}

/// The MAC-input prefix for a parameter set: extended params prepend 02 02 00 00.
export function macPrefixFor(params: bigint): Uint8Array {
  return (params & 0x18n) !== 0n ? new Uint8Array([0x02, 0x02, 0x00, 0x00]) : new Uint8Array();
}

export class AirShieldKeys {
  readonly encryption: Uint8Array;
  readonly mac: Uint8Array;

  private constructor(encryption: Uint8Array, mac: Uint8Array) {
    this.encryption = encryption;
    this.mac = mac;
  }

  /// AirShield key derivation, selected by the negotiated parameter bits (see AirShieldParams):
  ///   base (param 3):   IKM = SHA256(S), salt = SHA256(SHA256(S) || C || R)
  ///   extended (param 26/31): IKM = S,   salt = SHA256(C || R)
  ///   separate MAC (param 7/31): Kmac = HKDF over SHA256(R || C || "hmac_derive"); else Kmac = Kenc.
  static derive(secret: Uint8Array, challenge: Uint8Array, seed: Uint8Array, params: AirShieldParams = {}): AirShieldKeys {
    if (secret.length !== 32 || challenge.length !== 16 || seed.length !== 32) {
      throw new BandProtocolError("Invalid AirShield key material");
    }
    const hashed = new Uint8Array(createHash("sha256").update(secret).digest());
    const ikm = params.extended ? secret : hashed;
    const salt = params.extended
      ? new Uint8Array(createHash("sha256").update(concat(challenge, seed)).digest())
      : new Uint8Array(createHash("sha256").update(concat(hashed, challenge, seed)).digest());
    const encryption = new Uint8Array(hkdfSync("sha256", ikm, salt, "AirShield", 32));
    if (!params.separateMac) return new AirShieldKeys(encryption, encryption);
    const macSalt = new Uint8Array(createHash("sha256").update(concat(seed, challenge, new Uint8Array(Buffer.from("hmac_derive")))).digest());
    return new AirShieldKeys(encryption, new Uint8Array(hkdfSync("sha256", ikm, macSalt, "AirShield", 32)));
  }

  static fixed(encryption: Uint8Array, mac: Uint8Array): AirShieldKeys {
    return new AirShieldKeys(encryption, mac);
  }
}

function crypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array, encrypt: boolean): Uint8Array {
  if (key.length !== 32 || iv.length !== 16 || data.length === 0 || data.length % 16 !== 0) {
    throw new BandProtocolError("Invalid AES block shape");
  }
  const cipher = encrypt ? createCipheriv("aes-256-cbc", key, iv) : createDecipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return concat(new Uint8Array(cipher.update(data)), new Uint8Array(cipher.final()));
}

function mac8(key: Uint8Array, prefix: Uint8Array, counter: number, body: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(concat(prefix, u32le(counter), body)).digest()).subarray(0, 8);
}

export class AirShieldCipher {
  iv: Uint8Array;
  counter: number;

  /// `macPrefix` is prepended to the MAC input for extended parameter sets (02 02 00 00); empty
  /// for the param-3 base set.
  constructor(readonly keys: AirShieldKeys, iv: Uint8Array, counter: number, readonly macPrefix: Uint8Array = new Uint8Array()) {
    this.iv = iv;
    this.counter = counter >>> 0;
  }

  encrypt(frame: Uint8Array): Uint8Array {
    const count = (16 - (frame.length % 16)) % 16;
    const padded = concat(frame, new Uint8Array(count).fill(0xc0 + count));
    if (padded.length === 0 || padded.length > 4096) throw new BandProtocolError("AirShield frame too large");
    const ciphertext = crypt(padded, this.keys.encryption, this.iv, true);
    const body = concat(new Uint8Array([ciphertext.length / 16 - 1]), ciphertext);
    const tag = mac8(this.keys.mac, this.macPrefix, this.counter, body);
    this.iv = ciphertext.slice(ciphertext.length - 16);
    this.counter = (this.counter + 1) >>> 0;
    return concat(new Uint8Array([0x40]), tag, body);
  }

  decrypt(packet: Uint8Array): Uint8Array {
    const expected = mac8(this.keys.mac, this.macPrefix, this.counter, packet.subarray(9));
    // Compare every byte before decrypting. No unauthenticated plaintext leaves this type.
    if (!equalBytes(expected, packet.subarray(1, 9))) throw new BandProtocolError("Band packet authentication failed");
    const ciphertext = packet.slice(10);
    const plaintext = crypt(ciphertext, this.keys.encryption, this.iv, false);
    this.iv = ciphertext.slice(ciphertext.length - 16);
    this.counter = (this.counter + 1) >>> 0;
    return plaintext;
  }
}

export class AirShieldReceiver {
  private pending: Uint8Array = new Uint8Array();
  /// Diagnostics: every record the receiver passes over unauthenticated (0x81/0x82 control,
  /// 0x01/0x02 relay, 0x41/0x42 relay-encrypted).
  onSkipped?: (record: Uint8Array) => void;

  constructor(readonly cipher: AirShieldCipher) {}

  feed(bytes: Uint8Array): Uint8Array[] {
    this.pending = concat(this.pending, bytes);
    const plaintext: Uint8Array[] = [];
    while (this.pending.length > 0) {
      const marker = this.pending[0]!;
      if ((marker === 0x81 || marker === 0x82) && this.pending.length >= 2 && this.pending[1]! <= 1) {
        this.onSkipped?.(this.pending.slice(0, 2));
        this.pending = this.pending.slice(2);
        continue;
      }
      if (marker === 0x01 || marker === 0x02) {
        if (this.pending.length < 2) break;
        const size = 3 + this.pending[1]!;
        if (this.pending.length < size) break;
        this.onSkipped?.(this.pending.slice(0, size));
        this.pending = this.pending.slice(size);
        continue;
      }
      if ((marker === 0x81 || marker === 0x82) && this.pending.length < 2) break;
      if (marker !== 0x40 && marker !== 0x41 && marker !== 0x42) {
        throw new BandProtocolError("Unsupported band transport marker");
      }
      if (this.pending.length < 10) break;
      const size = 10 + (this.pending[9]! + 1) * 16;
      if (this.pending.length < size) break;
      if (marker === 0x40) plaintext.push(this.cipher.decrypt(this.pending.slice(0, size)));
      else this.onSkipped?.(this.pending.slice(0, size));
      // Relay channels are not part of the authenticated input service.
      this.pending = this.pending.slice(size);
    }
    return plaintext;
  }

  finish(): void {
    if (this.pending.length) throw new BandProtocolError("Truncated AirShield packet");
  }
}
