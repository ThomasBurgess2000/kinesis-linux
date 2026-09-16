import { describe, expect, test } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
import { BandSession } from "../src/session";
import { BandProtocolError, BandWire, DataXReceiver, ProtoFields, concat, hex } from "../src/wire";
import { Peer, engagement, failures, fromHex, has, movement, range, reportedHands, subscriptionAck } from "./peer";

const text = (s: string) => new TextEncoder().encode(s);

test("crypto matches the independent python vectors", () => {
  const keys = AirShieldKeys.derive(range(0, 32), range(0, 16), range(32, 64));
  expect(hex(keys.encryption)).toBe("5080496832e72e0a4de90f22e7797a3c6277197b4bd29f296bd7142850db1998");
  const fixedKeys = AirShieldKeys.fixed(range(0, 32), range(0, 32));
  const first = fromHex("40c9f748fb0f0ae8e0018675352ee743a1e58ccd288d25d27f6e72551887e4aad6fc68175e7287a1eee1");
  const second = fromHex("4038cb0decaa0692b900d5962230f8734c8a3de4d262936261f1");
  const receiver = new AirShieldReceiver(new AirShieldCipher(fixedKeys, range(0, 16), 0xffffffff));
  const wire = concat(first, new Uint8Array([0x81, 0, 1, 2, 42, 43, 44]), second);
  const decoded: Uint8Array[] = [];
  for (const byte of wire) decoded.push(...receiver.feed(new Uint8Array([byte])));
  receiver.finish();
  expect(decoded.map((d) => new TextDecoder().decode(d))).toEqual(["first block.....second block....", "last block......"]);
  expect(receiver.cipher.counter).toBe(1);
  const sender = new AirShieldCipher(fixedKeys, range(0, 16), 0xffffffff);
  expect(hex(sender.encrypt(decoded[0]!))).toBe(hex(first));
  expect(hex(sender.encrypt(decoded[1]!))).toBe(hex(second));
  for (const index of [1, 12]) {
    const corrupted = first.slice();
    corrupted[index]! ^= 1;
    const bad = new AirShieldReceiver(new AirShieldCipher(fixedKeys, range(0, 16), 0xffffffff));
    expect(() => bad.feed(corrupted)).toThrow(BandProtocolError);
    expect(bad.cipher.counter).toBe(0xffffffff);
    expect(hex(bad.cipher.iv)).toBe(hex(range(0, 16)));
  }
  const truncated = new AirShieldReceiver(new AirShieldCipher(fixedKeys, range(0, 16), 0xffffffff));
  expect(truncated.feed(first.subarray(0, first.length - 1))).toEqual([]);
  expect(() => truncated.finish()).toThrow(BandProtocolError);
});

describe("hand selection", () => {
  for (const selected of ["left", "right"] as const) {
    test(`${selected}: writes only handedness and checks an independent readback`, () => {
      const peer = new Peer();
      const initial = selected === "left" ? 0 : 1;
      const desired = selected === "left" ? 1 : 0;
      const query = peer.startup[peer.startup.length - 1]!;
      expect(query.channel).toBe(0x8006);
      expect(query.words).toEqual([0x8100ce56, 0x02000314]);
      expect(hex(query.payload)).toBe("08012a00");
      expect(() => peer.session.setHandedness(selected, 100)).toThrow(BandProtocolError);
      const read = peer.handReply(1, initial);
      expect(reportedHands(read.events)).toEqual([selected === "left" ? "right" : "left"]);
      expect(read.requests).toEqual([]);
      peer.send(0x02000315, subscriptionAck(3), 1);
      const request = peer.requests(peer.session.setHandedness(selected, 101));
      expect(request.length).toBe(1);
      expect(request[0]!.channel).toBe(0x8006);
      expect(request[0]!.words).toEqual([]);
      expect(hex(request[0]!.payload)).toBe(hex(new Uint8Array([0x08, 0x02, 0x2a, 0x02, 0x50, desired])));
      expect(() => peer.session.setHandedness(selected, 101)).toThrow(BandProtocolError);
      const stale = peer.handReply(1, desired);
      expect(reportedHands(stale.events)).toEqual([]);
      expect(stale.requests).toEqual([]);
      const wrongChannel = peer.handReply(2, desired, { channel: 7 });
      expect(reportedHands(wrongChannel.events)).toEqual([]);
      expect(wrongChannel.requests).toEqual([]);
      const written = peer.handReply(2, desired, { now: 2 });
      expect(reportedHands(written.events)).toEqual([]);
      expect(written.requests.length).toBe(1);
      expect(written.requests[0]!.channel).toBe(0x8006);
      expect(hex(written.requests[0]!.payload)).toBe("08032a00");
      const confirmed = peer.handReply(3, desired, { now: 3 });
      expect(reportedHands(confirmed.events)).toEqual([selected]);
      expect(peer.session.hand).toBe(selected);
      expect(confirmed.requests).toEqual([]);
    });
  }

  test("read rejects missing, invalid, and late values", () => {
    for (const value of [undefined, 2]) {
      const peer = new Peer();
      const result = peer.handReply(1, value);
      expect(reportedHands(result.events)).toEqual([]);
      expect(failures(result.events)).toBe(true);
      expect(peer.session.hand).toBeUndefined();
    }
    const peer = new Peer();
    expect(failures(peer.session.tick(106))).toBe(true);
    const late = peer.handReply(1, 1, { now: 7 });
    expect(reportedHands(late.events)).toEqual([]);
    expect(late.requests).toEqual([]);
    expect(peer.session.hand).toBeUndefined();
    const unticked = new Peer();
    const delayed = unticked.handReply(1, 1, { now: 7 });
    expect(reportedHands(delayed.events)).toEqual([]);
    expect(delayed.requests).toEqual([]);
    expect(failures(delayed.events)).toBe(true);
    expect(unticked.session.hand).toBeUndefined();
  });

  test("write rejection and mismatched readback never confirm the requested hand", () => {
    for (const rejected of [true, false]) {
      const peer = new Peer();
      peer.handReply(1, 0);
      peer.send(0x02000315, subscriptionAck(3), 1);
      peer.requests(peer.session.setHandedness("left", 101));
      const write = peer.handReply(2, 1, { status: rejected ? 2 : 1, now: 2 });
      const result = rejected ? write : peer.handReply(3, 0, { now: 3 });
      expect(reportedHands(result.events)).not.toContain("left");
      expect(failures(result.events)).toBe(true);
      expect(result.requests).toEqual([]);
      expect(peer.session.hand).not.toBe("left");
    }
  });
});

test("handshake subscribes and stops the same streams on the same channel", () => {
  const peer = new Peer();
  expect(peer.startup.map((f) => f.channel)).toEqual([0x8002, 0x8001, 0x8003, 0x8005, 0x8005, 0x8006]);
  expect(peer.startup[0]!.words).toEqual([0x81000024, 0x02003000]);
  expect(peer.startup[1]!.words).toEqual([0x02001000]);
  const end = new ProtoFields(peer.startup[1]!.payload);
  expect(end.integer(1)).toBe(1n);
  expect(end.bytes(2).length).toBe(16);
  expect(peer.startup[3]!.words).toEqual([0x8100ce56, 0x02000314]);
  expect(peer.startup[4]!.words).toEqual([]);
  const enabled = new ProtoFields(new ProtoFields(peer.startup[4]!.payload).bytes(4));
  for (const field of [3, 6, 8]) expect(enabled.integer(field)).toBe(1n);
  expect(enabled.contains(2)).toBe(false);
  const stop = peer.session.stop();
  const frames = peer.requests(stop);
  const frame = frames[0]!;
  expect(frame.channel).toBe(0x8005);
  expect(frame.words).toEqual([]);
  const request = new ProtoFields(frame.payload);
  expect(request.integer(1)).toBe(4n);
  const disabled = new ProtoFields(request.bytes(4));
  for (const field of [3, 6, 8]) expect(disabled.requiredInteger(field)).toBe(0n);
  const partial = concat(BandWire.field(1, 4), BandWire.field(2, 1), BandWire.field(5, BandWire.field(3, 0)));
  peer.send(0x02000315, partial, 1);
  expect(peer.session.stopAcknowledged).toBe(false);
  peer.send(0x02000315, subscriptionAck(4, 0), 2);
  expect(peer.session.stopAcknowledged).toBe(true);
  expect(peer.gesture(1, 3)).toEqual([]);
  expect(peer.session.stop().length).toBe(0);
});

test("encrypted input drives the dial and releases on motion loss", () => {
  const peer = new Peer();
  const first = peer.gyro(1_000_000, 0);
  expect(has(first, "connected")).toBe(true);
  expect(has(first, "heartbeat")).toBe(true);
  expect(engagement(peer.gesture(1, 0.01, { synthetic: 1 }))).toEqual([]);
  const press = peer.gesture(1, 0.02);
  expect(engagement(press)).toEqual([true]);
  const payload = press[0]!.payload;
  if (payload.type !== "gesture") throw new Error("Missing gesture");
  expect(payload.gesture.finger).toBe("index");
  expect(payload.gesture.action).toBe("press");
  expect(payload.gesture.synthetic).toBe(false);
  expect(payload.gesture.sequence).toBe(10n);
  expect(payload.gesture.timestampUs).toBe(20n);
  expect(payload.gesture.receivedAt).toBe(100.02);
  expect(engagement(peer.gesture(0, 0.021, { derived: 9 }))).toEqual([]);
  const turn = movement(peer.gyro(1_010_000, 0.03));
  expect(turn.length).toBe(1);
  expect(Math.abs(turn[0]! - 0.7)).toBeLessThan(1e-9);
  expect(engagement(peer.session.tick(100.5))).toEqual([false]);
  expect(movement(peer.gyro(1_020_000, 0.51))).toEqual([]);
  expect(engagement(peer.gesture(1, 0.52))).toEqual([true]);
  expect(engagement(peer.gyro(2_000_000, 0.53))).toEqual([false]);
  expect(movement(peer.gyro(2_010_000, 0.54))).toEqual([]);
  expect(engagement(peer.gesture(1, 0.55))).toEqual([true]);
  expect(engagement(peer.gesture(2, 0.56))).toEqual([false]);
  expect(movement(peer.gyro(2_020_000, 0.57))).toEqual([]);
});

test("framing preserves split messages and rejects malformed input", () => {
  const receiver = new DataXReceiver();
  const payload = range(0, 40);
  const frame = BandWire.frame(0x8005, [0x0200020d], payload);
  const head = concat(frame.subarray(0, 13), new Uint8Array(3).fill(0xc3));
  expect(receiver.feed(head)).toEqual([]);
  const tail = concat(frame.subarray(13), new Uint8Array(13).fill(0xcd));
  const frames = receiver.feed(tail);
  expect(frames.map((f) => f.channel)).toEqual([0x8005]);
  expect(frames[0]!.words).toEqual([0x0200020d]);
  expect(hex(frames[0]!.payload)).toBe(hex(payload));
  expect(() => new ProtoFields(new Uint8Array([0x08, 0x80]))).toThrow(BandProtocolError);
  expect(() => new ProtoFields(new Uint8Array([0x08, 1, 0x08, 2])).requiredInteger(1)).toThrow(BandProtocolError);
  expect(() => new ProtoFields(new Uint8Array([0x1a, 12, 1]))).toThrow(BandProtocolError);
  const session = new BandSession();
  expect(() => session.feed(new Uint8Array([0, 0, 0, 0]), 0)).toThrow(BandProtocolError);
});

test("a quiet band stays connected through acknowledged status queries", () => {
  const peer = new Peer();
  const started = peer.send(0x02000315, subscriptionAck(3), 0);
  expect(has(started, "connected")).toBe(true);
  expect(has(started, "heartbeat")).toBe(true);
  expect(peer.session.streamsEnabled).toBe(true);
  expect(peer.session.motionMessages).toBe(0);
  const query = peer.session.queryStreamState();
  const frame = peer.requests(query)[0]!;
  expect(frame.channel).toBe(0x8005);
  expect(frame.words).toEqual([]);
  const fields = new ProtoFields(frame.payload);
  expect(fields.integer(1)).toBe(5n);
  expect(fields.bytes(4).length).toBe(0);
  const reply = peer.send(0x02000315, subscriptionAck(5), 2);
  expect(has(reply, "heartbeat")).toBe(true);
  expect(has(reply, "connected")).toBe(false);
  expect(movement(reply)).toEqual([]);
  peer.session.stop();
  expect(peer.session.queryStreamState().length).toBe(0);
});

test("startup motion does not turn an old press into a new pinch", () => {
  const peer = new Peer();
  expect(engagement(peer.gesture(1, 0))).toEqual([]);
  peer.gyro(1_000_000, 0.01);
  expect(engagement(peer.gesture(0, 0.02, { derived: 9 }))).toEqual([]);
  expect(movement(peer.gyro(1_010_000, 0.03))).toEqual([]);
  peer.gesture(2, 0.04);
  expect(engagement(peer.gesture(1, 0.05))).toEqual([true]);
  expect(movement(peer.gyro(1_020_000, 0.06)).length).toBeGreaterThan(0);
});

test("unknown repeated fields do not break known gesture messages", () => {
  const peer = new Peer();
  const payload = concat(BandWire.field(1, 42), BandWire.field(2, 1000), BandWire.field(3, 1), BandWire.field(4, 8),
    BandWire.field(99, 1), BandWire.field(99, 2));
  const events = peer.send(0x0200020d, payload, 0);
  const first = events[0]!.payload;
  if (first.type !== "gesture") throw new Error("Missing gesture");
  expect(first.gesture.finger).toBe("thumb");
  expect(first.gesture.action).toBe("left");
  expect(first.gesture.sequence).toBe(42n);
  expect(first.gesture.timestampUs).toBe(1000n);
  expect(() => peer.send(0x0200020d, concat(payload, BandWire.field(1, 43)), 1)).toThrow(BandProtocolError);
});

test("rejected subscriptions fail without reporting a ready connection", () => {
  const peer = new Peer();
  expect(() => peer.send(0x02000315, concat(BandWire.field(1, 3), BandWire.field(2, 2)), 0)).toThrow(BandProtocolError);
  expect(peer.session.streamsEnabled).toBe(false);
});

test("another rpc channel cannot acknowledge the input subscription", () => {
  const peer = new Peer();
  const unrelated = BandWire.frame(7, [0x02000315], concat(BandWire.field(1, 5), BandWire.field(2, 1), BandWire.field(6, new Uint8Array())));
  const events = peer.session.feed(peer.sender.encrypt(unrelated), 100).events;
  expect(events).toEqual([]);
  expect(peer.session.streamsEnabled).toBe(false);
});

test("text helper", () => {
  expect(text("a").length).toBe(1);
});
