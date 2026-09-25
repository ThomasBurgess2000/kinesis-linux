import { expect, test } from "bun:test";
import { AirShieldCipher, AirShieldKeys, AirShieldReceiver } from "../src/airshield";
import { OwnershipCeremony } from "../src/ceremony";
import { parseEMGBatch } from "../src/emg";
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

test("only one battery query is outstanding at a time", () => {
  const session = new BandSession();
  new SyntheticBand(session);
  expect(session.queryBatteryStatus(100).length).toBeGreaterThan(0);
  expect(session.queryBatteryStatus(100).length).toBe(0);
});

test("a battery reply resolves the pending request; an unanswered one times out", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  const answered = band.deliver(session.queryBatteryStatus(100));
  const status = answered.find((e) => e.payload.type === "batteryStatus");
  expect(status?.payload).toEqual({ type: "batteryStatus", status: { level: 76, charging: true } });

  session.queryBatteryStatus(200); // never delivered to the band
  expect(session.tick(202).some((e) => e.payload.type === "batteryStatus")).toBe(false);
  expect(session.tick(203.5).find((e) => e.payload.type === "batteryStatus")?.payload).toEqual({ type: "batteryStatus", status: undefined });
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

test("raw sEMG turns on alongside gestures, its batches come through, and stop turns it off too", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  const events = band.deliver(session.setRawEMGEnabled(true, 100));
  const config = events.find((e) => e.payload.type === "rawEMGConfiguration");
  expect(config?.payload).toMatchObject({ config: { sampleRate: 2048, channels: 8, adcBits: 16, samplesPerBatch: 16, encoding: 0 } });
  expect(events.find((e) => e.payload.type === "rawEMGState")?.payload).toEqual({ type: "rawEMGState", enabled: true });
  expect(session.streamsEnabled).toBe(true);

  const frame = band.emg(7, 5_000_000).find((e) => e.payload.type === "rawEMGFrame");
  const batch = parseEMGBatch((frame!.payload as { payload: Uint8Array }).payload);
  expect(batch.sequence).toBe(7n);
  expect(batch.values[0]).toBe(1000);
  expect(batch.values[15 * 8 + 7]).toBe(1157);
  expect(session.rawEMGFrames).toBe(1);

  const stop = new ProtoFields(new ProtoFields(band.read(session.stop())[0]!.payload).bytes(4));
  expect([2, 3, 6, 8].map((f) => stop.integer(f))).toEqual([0n, 0n, 0n, 0n]);
});

test("readings requested before a reconnect come back on with the subscription", () => {
  const session = new BandSession({ rawEMG: true });
  const band = new SyntheticBand(session);
  expect(has(band.setupEvents, "connected")).toBe(true);
  expect(band.setupEvents.find((e) => e.payload.type === "rawEMGState")?.payload).toEqual({ type: "rawEMGState", enabled: true });
});

test("gyro and orientation samples come through as events", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  const gyro = band.gyro([100, -200, 300], 5_000_000).find((e) => e.payload.type === "gyro");
  expect(gyro?.payload).toEqual({ type: "gyro", timestampUs: 5_000_000n, values: [100, -200, 300] });
  const quaternion = band.orientation([1, 0, 0, 0], 5_010_000).find((e) => e.payload.type === "orientation");
  expect(quaternion?.payload).toEqual({ type: "orientation", timestampUs: 5_010_000n, values: [1, 0, 0, 0] });
});

test("motion streams switch while connected, one change at a time, and restart on request", () => {
  const session = new BandSession({ motion: { gyro: true, orientation: false } });
  const band = new SyntheticBand(session);
  const subscribe = band.setupEvents;
  expect(has(subscribe, "connected")).toBe(true);
  expect(session.motionStreams).toEqual({ gyro: true, orientation: false });

  // Orientation on. A second change waits for the first to be answered.
  const request = session.setMotionStreams({ gyro: true, orientation: true }, 100);
  expect(session.setMotionStreams({ gyro: true, orientation: false }, 100).length).toBe(0);
  const answered = band.deliver(request);
  // Every stream field is set explicitly (this is the second change, orientation off again).
  const control = band.lastControl!;
  expect([3, 6, 8].map((f) => control.integer(f))).toEqual([1n, 1n, 0n]);
  expect(control.contains(2)).toBe(false);
  const changes = answered.filter((e) => e.payload.type === "motionStreams").map((e) => e.payload);
  // The first is confirmed; the waiting one goes out with it and is confirmed in turn.
  expect(changes).toMatchObject([
    { streams: { gyro: true, orientation: true }, accepted: true },
    { streams: { gyro: true, orientation: false }, accepted: true },
  ]);
  expect(session.motionStreams).toEqual({ gyro: true, orientation: false });

  // A restart turns motion off, then back to what it was. Here the change before it is never
  // answered, so the restart waits, and the unanswered change is given up after 8 s.
  band.muteStreams = true;
  band.deliver(session.setMotionStreams({ gyro: true, orientation: true }, 101));
  expect(session.restartMotionStreams(102).length).toBe(0);
  expect(session.tick(110).find((e) => e.payload.type === "motionStreams")?.payload).toMatchObject({ accepted: false });
  band.muteStreams = false;
  // An earlier change failing leaves the restart waiting: the connection's tick sends it.
  const off = session.flushMotion(111);
  const restored = band.deliver(off).filter((e) => e.payload.type === "motionStreams").map((e) => e.payload);
  expect(restored).toMatchObject([{ streams: { gyro: false, orientation: false } }, { streams: { gyro: true, orientation: true } }]);
  expect(session.streamsEnabled).toBe(true);
});

test("a refused motion change leaves the streams as they were", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  band.refuseMotion = true;
  const events = band.deliver(session.setMotionStreams({ gyro: true, orientation: false }, 100));
  expect(events.find((e) => e.payload.type === "motionStreams")?.payload).toMatchObject({
    streams: { gyro: true, orientation: true }, accepted: false,
  });
  expect(session.motionStreams).toEqual({ gyro: true, orientation: true });
});

test("streams asked for before the subscription are what it subscribes to", () => {
  const session = new BandSession();
  expect(session.setMotionStreams({ gyro: true, orientation: false }, 0).length).toBe(0);
  const band = new SyntheticBand(session);
  expect(has(band.setupEvents, "connected")).toBe(true);
  expect(session.motionStreams).toEqual({ gyro: true, orientation: false });
});
