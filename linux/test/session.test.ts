import { expect, test } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
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
