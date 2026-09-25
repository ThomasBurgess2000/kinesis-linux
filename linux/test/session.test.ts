import { expect, test } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
import { OwnershipCeremony } from "../src/ceremony";
import type { BandEvent } from "../src/gestures";
import { SigningKey } from "../src/identity";
import { BandSession } from "../src/session";
import { BandProtocolError, BandWire, DataXReceiver, ProtoFields, concat, hex } from "../src/wire";
import { SyntheticBand, has, range } from "./band";
import { fromHex } from "../src/wire";

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
});

test("framing preserves split messages and rejects malformed input", () => {
  const receiver = new DataXReceiver();
  const payload = range(0, 40);
  const frame = BandWire.frame(0x8005, [0x0200020d], payload);
  expect(receiver.feed(concat(frame.subarray(0, 13), new Uint8Array(3).fill(0xc3)))).toEqual([]);
  const frames = receiver.feed(concat(frame.subarray(13), new Uint8Array(13).fill(0xcd)));
  expect(frames.map((f) => f.channel)).toEqual([0x8005]);
  expect(hex(frames[0]!.payload)).toBe(hex(payload));
  expect(() => new ProtoFields(new Uint8Array([0x08, 0x80]))).toThrow(BandProtocolError);
  const session = new BandSession();
  expect(() => session.feed(new Uint8Array([0, 0, 0, 0]), 0)).toThrow(BandProtocolError);
});

test("a frame split across records drops each record's padding, including a whole padding block", () => {
  // A 42-byte frame the band splits after 32 bytes: the aligned first record carries a full
  // 16-byte 0xd0 padding block, the second carries the last 10 bytes plus 6 of 0xc6.
  const body = range(0, 34);
  const frame = BandWire.frame(0x8002, [0x02002003], body);
  expect(frame.length).toBe(42);
  const first = concat(frame.subarray(0, 32), new Uint8Array(16).fill(0xd0));
  const rest = frame.subarray(32);
  const second = concat(rest, new Uint8Array(16 - rest.length).fill(0xc0 + 16 - rest.length));
  const datax = new DataXReceiver();
  expect(datax.feed(first)).toEqual([]);
  const frames = datax.feed(second);
  expect(frames.length).toBe(1);
  expect(hex(frames[0]!.payload)).toBe(hex(body));
});

test("the un-enrolled staged flow reaches a live stream and decodes a gesture", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  expect(has(band.setupEvents, "connected")).toBe(true);
  expect(session.streamsEnabled).toBe(true);
  // The hand read resolved from the band's config echo.
  expect(session.hand).toBe("right");

  const events = band.gesture(3, 1); // index tap
  const gesture = events.find((e) => e.payload.type === "gesture");
  expect(gesture && gesture.payload.type === "gesture" && gesture.payload.gesture.action).toBe("tap");

  // Stop asks the band to disable; the ack is on the stream channel.
  const stop = session.stop();
  const frame = band.read(stop)[0]!;
  expect(frame.channel).toBe(0x8005);
  expect(new ProtoFields(frame.payload).integer(1)).toBe(4n);
  band.sendStopAck();
  expect(session.stopAcknowledged).toBe(true);
});

test("a band offering the extended set (27, sends 26) gets a host that declares and sends 26", () => {
  const appKey = SigningKey.generate();
  const bandKey = SigningKey.generate();
  const session = new BandSession({ enrollment: { privateKey: appKey, bandPublicKey: bandKey.publicPoint } });
  const band = new SyntheticBand(session, { signingKey: bandKey, offerParams: 27, sendParams: 26 });
  expect(session.declaredParams).toBe(26n);
  expect(session.negotiatedParams).toBe(26n);
  expect(has(band.setupEvents, "connected")).toBe(true);
  expect(session.streamsEnabled).toBe(true);
});

test("enrollment claims the band, then trusts the proof the band sends on its already-open channel", () => {
  const bandKey = SigningKey.generate();
  const ceremony = new OwnershipCeremony("AA:BB:CC:00:11:22");
  const session = new BandSession({ ceremony });
  const band = new SyntheticBand(session, { signingKey: bandKey, offerParams: 27, sendParams: 26, ceremony: true });
  const http = (events: BandEvent[]) => events.flatMap((e) => (e.payload.type === "ceremonyHTTP" ? [e.payload.request.kind] : []));

  expect(http(band.setupEvents)).toEqual(["pairRequest"]);
  const afterClaim = band.deliver(session.ceremonyPairRequestCompleted(range(0, 70), "{\"server\":\"pending\"}"));
  expect(http(afterClaim)).toEqual(["pair"]);
  const afterPair = band.deliver(session.ceremonyPairCompleted(range(0, 70), "{\"server\":\"final\"}", bandKey.publicPoint));

  // The follow-up proof carries no type words; it must still count, or trust never completes.
  expect(has(afterPair, "connected")).toBe(true);
  expect(session.streamsEnabled).toBe(true);
  expect(hex(session.enrolledIdentity!.privateKey.publicPoint)).toBe(hex(ceremony.appPublicKey));
});

test("the declared parameter set follows the band's offer", () => {
  expect(BandSession.declareParams(3n)).toBe(3n);
  expect(BandSession.declareParams(27n)).toBe(26n);
  expect(BandSession.declareParams(31n)).toBe(26n);
  expect(() => BandSession.declareParams(1n)).toThrow(BandProtocolError);
});

test("an enrolled session proves ownership with EnableTrust and verifies the band's proof", () => {
  const appKey = SigningKey.generate();
  const bandKey = SigningKey.generate();
  const session = new BandSession({ enrollment: { privateKey: appKey, bandPublicKey: bandKey.publicPoint } });
  const band = new SyntheticBand(session, { signingKey: bandKey });
  expect(has(band.setupEvents, "connected")).toBe(true);
  expect(session.streamsEnabled).toBe(true);
});

test("an enrolled session rejects a band proof signed by the wrong key", () => {
  const appKey = SigningKey.generate();
  const expected = SigningKey.generate();
  const wrong = SigningKey.generate();
  const session = new BandSession({ enrollment: { privateKey: appKey, bandPublicKey: expected.publicPoint } });
  expect(() => new SyntheticBand(session, { signingKey: wrong })).toThrow();
  expect(session.streamsEnabled).toBe(false);
});

test("without a stored band key, the band proof is accepted unverified (advisory)", () => {
  const appKey = SigningKey.generate();
  const session = new BandSession({ enrollment: { privateKey: appKey } });
  const band = new SyntheticBand(session, { signingKey: SigningKey.generate() });
  expect(has(band.setupEvents, "connected")).toBe(true);
});
