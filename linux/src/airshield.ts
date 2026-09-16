// AirShield transport crypto: P-256 ECDH secret -> HKDF keys, AES-256-CBC with
// chained IVs, and a truncated HMAC-SHA256 checked before any plaintext is released.
// Port of Sources/KinesisCore/AirShield.swift (parameter-3 branch only).

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { BandProtocolError, concat, equalBytes, u32le } from "./wire";

export class AirShieldKeys {
  readonly encryption: Uint8Array;
  readonly mac: Uint8Array;

  private constructor(encryption: Uint8Array, mac: Uint8Array) {
    this.encryption = encryption;
    this.mac = mac;
  }

  // Only the parameter-3 exchange has been verified on this band.
  static derive(secret: Uint8Array, challenge: Uint8Array, seed: Uint8Array): AirShieldKeys {
    if (secret.length !== 32 || challenge.length !== 16 || seed.length !== 32) {
      throw new BandProtocolError("Invalid AirShield key material");
    }
    const hashed = createHash("sha256").update(secret).digest();
    const salt = createHash("sha256").update(concat(hashed, challenge, seed)).digest();
    const encryption = new Uint8Array(hkdfSync("sha256", hashed, salt, "AirShield", 32));
    return new AirShieldKeys(encryption, encryption);
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

function mac8(key: Uint8Array, counter: number, body: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(concat(u32le(counter), body)).digest()).subarray(0, 8);
}

export class AirShieldCipher {
  iv: Uint8Array;
  counter: number;

  constructor(readonly keys: AirShieldKeys, iv: Uint8Array, counter: number) {
    this.iv = iv;
    this.counter = counter >>> 0;
  }

  encrypt(frame: Uint8Array): Uint8Array {
    const count = (16 - (frame.length % 16)) % 16;
    const padded = concat(frame, new Uint8Array(count).fill(0xc0 + count));
    if (padded.length === 0 || padded.length > 4096) throw new BandProtocolError("AirShield frame too large");
    const ciphertext = crypt(padded, this.keys.encryption, this.iv, true);
    const body = concat(new Uint8Array([ciphertext.length / 16 - 1]), ciphertext);
    const tag = mac8(this.keys.mac, this.counter, body);
    this.iv = ciphertext.slice(ciphertext.length - 16);
    this.counter = (this.counter + 1) >>> 0;
    return concat(new Uint8Array([0x40]), tag, body);
  }

  decrypt(packet: Uint8Array): Uint8Array {
    const expected = mac8(this.keys.mac, this.counter, packet.subarray(9));
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

  constructor(readonly cipher: AirShieldCipher) {}

  feed(bytes: Uint8Array): Uint8Array[] {
    this.pending = concat(this.pending, bytes);
    const plaintext: Uint8Array[] = [];
    while (this.pending.length > 0) {
      const marker = this.pending[0]!;
      if ((marker === 0x81 || marker === 0x82) && this.pending.length >= 2 && this.pending[1]! <= 1) {
        this.pending = this.pending.slice(2);
        continue;
      }
      if (marker === 0x01 || marker === 0x02) {
        if (this.pending.length < 2) break;
        const size = 3 + this.pending[1]!;
        if (this.pending.length < size) break;
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
      // Relay channels are not part of the authenticated input service.
      this.pending = this.pending.slice(size);
    }
    return plaintext;
  }

  finish(): void {
    if (this.pending.length) throw new BandProtocolError("Truncated AirShield packet");
  }
}
