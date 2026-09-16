// A synthetic band using public P-256 scalar 1. All material is generated in tests.
// Port of the Peer helper in Tests/KinesisCoreTests/BandSessionTests.swift.

import { createECDH } from "node:crypto";
import { expect } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
import type { BandEvent, BandHand } from "../src/gestures";
import { BandSession } from "../src/session";
import { BandWire, DataXReceiver, type DataXFrame, ProtoFields, be16, concat, fromHex, hex, i16le } from "../src/wire";

export const range = (from: number, to: number): Uint8Array => Uint8Array.from({ length: to - from }, (_, i) => from + i);

export class Peer {
  readonly session = new BandSession();
  readonly sender: AirShieldCipher;
  readonly receiver: AirShieldReceiver;
  readonly datax = new DataXReceiver();
  readonly startup: DataXFrame[];

  constructor() {
    const request = this.session.request();
    expect(hex(request.subarray(0, 12))).toBe("806280018100000502000001");
    const local = new ProtoFields(request.subarray(12));
    const peer = createECDH("prime256v1");
    peer.setPrivateKey(Buffer.from(concat(new Uint8Array(31), new Uint8Array([1]))));
    const point = new Uint8Array(peer.getPublicKey()).subarray(1);
    const challenge = range(0, 16), seed = range(0, 32), iv = range(16, 32);
    const peerRequest = BandWire.frame(0x8001, [0x81000005, 0x02000001], concat(
      BandWire.field(1, point), BandWire.field(2, challenge), BandWire.field(3, 0), BandWire.field(4, 3)));
    const peerEnable = BandWire.frame(1, [0x02000002], concat(
      BandWire.field(1, point), BandWire.field(2, seed), BandWire.field(3, iv), BandWire.field(4, 42), BandWire.field(5, 3)));
    let output: Uint8Array = new Uint8Array();
    for (const byte of concat(peerRequest, peerEnable)) {
      const result = this.session.feed(new Uint8Array([byte]), 100);
      output = concat(output, result.outgoing);
      expect(result.events).toEqual([]);
    }
    const size = (be16(output, 0) & 0x7fff) + 4;
    const enable = new ProtoFields(output.subarray(8, size));
    expect(hex(enable.bytes(1))).toBe(hex(local.bytes(1)));
    expect(enable.integer(5)).toBe(3n);
    const secret = new Uint8Array(peer.computeSecret(Buffer.from(concat(new Uint8Array([4]), local.bytes(1)))));
    this.sender = new AirShieldCipher(AirShieldKeys.derive(secret, local.bytes(2), seed), iv, 42);
    this.receiver = new AirShieldReceiver(new AirShieldCipher(
      AirShieldKeys.derive(secret, challenge, enable.bytes(2)), enable.bytes(3), Number(enable.integer(4))));
    const frames: DataXFrame[] = [];
    for (const plain of this.receiver.feed(output.subarray(size))) frames.push(...this.datax.feed(plain));
    this.startup = frames;
  }

  send(kind: number, payload: Uint8Array, now: number): BandEvent[] {
    const frame = BandWire.frame(kind === 0x02000315 ? 0x5 : 0x8010, [kind], payload);
    return this.session.feed(this.sender.encrypt(frame), 100 + now).events;
  }

  gyro(stamp: number, now: number, x = 1000): BandEvent[] {
    return this.send(0x0200020f, concat(BandWire.field(1, stamp), BandWire.field(2, stamp),
      BandWire.field(3, concat(i16le(x), i16le(0), i16le(0)))), now);
  }

  gesture(action: number, now: number, options: { finger?: number; derived?: number; synthetic?: number } = {}): BandEvent[] {
    return this.send(0x0200020d, concat(BandWire.field(1, 10), BandWire.field(2, 20),
      BandWire.field(3, options.finger ?? 2), BandWire.field(4, action), BandWire.field(5, options.derived ?? 0),
      BandWire.field(12, options.synthetic ?? 0)), now);
  }

  requests(bytes: Uint8Array): DataXFrame[] {
    return this.receiver.feed(bytes).flatMap((plain) => this.datax.feed(plain));
  }

  handReply(id: number, value: number | undefined, options: { status?: number; channel?: number; now?: number } = {}):
    { events: BandEvent[]; requests: DataXFrame[] } {
    const config = concat(value === undefined ? new Uint8Array() : BandWire.field(10, value), BandWire.field(2, 2048));
    const payload = concat(BandWire.field(1, id), BandWire.field(2, options.status ?? 1), BandWire.field(6, config));
    const frame = BandWire.frame(options.channel ?? 6, [0x02000315], payload);
    const result = this.session.feed(this.sender.encrypt(frame), 100 + (options.now ?? 1));
    return { events: result.events, requests: this.requests(result.outgoing) };
  }
}

export const subscriptionAck = (id: number, enabled = 1): Uint8Array => concat(
  BandWire.field(1, id), BandWire.field(2, 1),
  BandWire.field(5, concat(BandWire.field(3, enabled), BandWire.field(6, enabled), BandWire.field(8, enabled))));

export const reportedHands = (events: BandEvent[]): BandHand[] =>
  events.flatMap((e) => (e.payload.type === "handedness" ? [e.payload.hand] : []));
export const failures = (events: BandEvent[]): boolean => events.some((e) => e.payload.type === "handednessFailure");
export const engagement = (events: BandEvent[]): boolean[] =>
  events.flatMap((e) => (e.payload.type === "dialState" ? [e.payload.engaged] : []));
export const movement = (events: BandEvent[]): number[] =>
  events.flatMap((e) => (e.payload.type === "dialTurn" ? [e.payload.rotation] : []));
export const has = (events: BandEvent[], type: BandEvent["payload"]["type"]): boolean =>
  events.some((e) => e.payload.type === type);
export { fromHex };
