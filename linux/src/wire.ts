// DataX framing and the minimal protobuf reader/writer the band protocol needs.
// Port of Sources/KinesisCore/BandWire.swift.

export class BandProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BandProtocolError";
  }
}

type Value = { kind: "integer"; value: bigint } | { kind: "bytes"; value: Uint8Array } | { kind: "fixed" };

export class ProtoFields {
  private values = new Map<number, Value[]>();

  constructor(data: Uint8Array) {
    let offset = 0;
    const varint = (): bigint => {
      let value = 0n;
      for (let shift = 0; shift <= 63; shift += 7) {
        if (offset >= data.length) throw new BandProtocolError("Truncated protobuf varint");
        const byte = data[offset++]!;
        if (shift >= 63 && byte > 1) throw new BandProtocolError("Protobuf varint overflow");
        value |= BigInt(byte & 127) << BigInt(shift);
        if (byte < 128) return value;
      }
      throw new BandProtocolError("Unterminated protobuf varint");
    };
    while (offset < data.length) {
      const tag = varint();
      const number = Number(tag >> 3n);
      if (!(number > 0 && number < 1 << 29)) throw new BandProtocolError("Invalid protobuf field number");
      const wire = Number(tag & 7n);
      const list = this.values.get(number) ?? [];
      this.values.set(number, list);
      if (wire === 0) {
        list.push({ kind: "integer", value: varint() });
        continue;
      }
      let size: number;
      switch (wire) {
        case 1: size = 8; break;
        case 2: size = Number(varint()); break;
        case 5: size = 4; break;
        default: throw new BandProtocolError("Unsupported protobuf wire type");
      }
      if (size > data.length - offset) throw new BandProtocolError("Truncated protobuf field");
      if (wire === 2) list.push({ kind: "bytes", value: data.slice(offset, offset + size) });
      else list.push({ kind: "fixed" });
      offset += size;
    }
  }

  integer(field: number, fallback = 0n): bigint {
    const list = this.values.get(field);
    if (!list) return fallback;
    const only = list.length === 1 ? list[0] : undefined;
    if (!only || only.kind !== "integer") throw new BandProtocolError("Expected protobuf integer");
    return only.value;
  }

  requiredInteger(field: number): bigint {
    if (!this.values.has(field)) throw new BandProtocolError("Missing protobuf integer");
    return this.integer(field);
  }

  bytes(field: number, count?: number): Uint8Array {
    const list = this.values.get(field);
    const only = list && list.length === 1 ? list[0] : undefined;
    if (!only || only.kind !== "bytes" || (count !== undefined && only.value.length !== count)) {
      throw new BandProtocolError("Invalid protobuf byte field");
    }
    return only.value;
  }

  contains(field: number): boolean {
    return this.values.has(field);
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function be16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

export function be32(data: Uint8Array, offset: number): number {
  return ((be16(data, offset) << 16) | be16(data, offset + 2)) >>> 0;
}

export function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

export function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

export function i16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

export const BandWire = {
  varint(value: bigint | number): Uint8Array {
    let v = BigInt(value);
    const bytes: number[] = [];
    while (v >= 128n) {
      bytes.push(Number(v & 127n) | 128);
      v >>= 7n;
    }
    bytes.push(Number(v));
    return new Uint8Array(bytes);
  },
  field(number: number, value: bigint | number | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) {
      return concat(BandWire.varint((number << 3) | 2), BandWire.varint(value.length), value);
    }
    return concat(BandWire.varint(number << 3), BandWire.varint(value));
  },
  frame(channel: number, words: number[] = [], payload: Uint8Array = new Uint8Array()): Uint8Array {
    const body = concat(...words.map(u32be), payload);
    if (body.length > 0x7fff) throw new BandProtocolError("DataX frame too large");
    const size = body.length | (words.length ? 0x8000 : 0);
    return concat(u16be(size), u16be(channel), body);
  },
};

export interface DataXFrame {
  channel: number;
  words: number[];
  payload: Uint8Array;
}

export class DataXReceiver {
  private pending: Uint8Array = new Uint8Array();

  feed(plaintext: Uint8Array): DataXFrame[] {
    if (plaintext.length === 0 || plaintext.length % 16 !== 0) {
      throw new BandProtocolError("Unaligned DataX plaintext");
    }
    let bytes = plaintext;
    const padding = bytes[bytes.length - 1]! - 0xc0;
    // Only the repeated suffix observed on the tested firmware is stripped.
    if (padding >= 1 && padding <= 15 && bytes.subarray(bytes.length - padding).every((b) => b === 0xc0 + padding)) {
      bytes = bytes.subarray(0, bytes.length - padding);
    }
    this.pending = concat(this.pending, bytes);
    const frames: DataXFrame[] = [];
    while (this.pending.length >= 4) {
      const length = be16(this.pending, 0);
      const size = (length & 0x7fff) + 4;
      if (this.pending.length < size) break;
      const channel = be16(this.pending, 2);
      let offset = 4;
      const words: number[] = [];
      if (length & 0x8000) {
        do {
          if (offset + 4 > size) throw new BandProtocolError("Truncated DataX typed header");
          words.push(be32(this.pending, offset));
          offset += 4;
        } while (words[words.length - 1]! & 0x80000000);
      }
      frames.push({ channel, words, payload: this.pending.slice(offset, size) });
      this.pending = this.pending.slice(size);
    }
    return frames;
  }
}

export function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
