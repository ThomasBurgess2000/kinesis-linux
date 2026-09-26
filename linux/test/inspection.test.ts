import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BandRecords } from "../src/band-records";
import { decodeProto, formatProto } from "../src/protoview";
import { BandSession } from "../src/session";
import { BandWire, concat, fromHex } from "../src/wire";
import { SyntheticBand } from "./band";

test("the decoder names the fields the phone app's name maps gave", () => {
  // neural-band-poc's documented request: request 6, set left-handed.
  const request = decodeProto(fromHex("08062a025001"), "RpcRequest")!;
  expect(formatProto(request)).toBe("1 requestId = 6\n5 configReq {\n  10 isLeftHanded = 1\n}");
  // Unknown fields still show, by number: a nested message, text, and raw bytes.
  const unknown = decodeProto(concat(BandWire.field(99, BandWire.field(1, 7)), BandWire.field(98, new TextEncoder().encode("Swiftlet-PS")),
    BandWire.field(97, new Uint8Array([0xff, 0x00]))))!;
  expect(formatProto(unknown)).toBe('99 {\n  1 = 7\n}\n98 = "Swiftlet-PS"\n97 = 0xff00 (2 bytes)');
  expect(decodeProto(new Uint8Array([0x0a, 0x05, 0x01]))).toBeUndefined();
});

test("replies other than sensor data come through as inspection events", () => {
  const session = new BandSession();
  const band = new SyntheticBand(session);
  const channels = band.setupEvents.filter((e) => e.payload.type === "inspection").map((e) => e.payload.type === "inspection" ? e.payload.channel & 0xff : 0);
  // The device info reply, the subscription reply, and the configuration (hand) reply.
  expect(channels).toEqual(expect.arrayContaining([3, 5, 6]));
  const config = band.setupEvents.find((e) => e.payload.type === "inspection" && (e.payload.channel & 0xff) === 6);
  expect(config?.payload.type === "inspection" && formatProto(decodeProto(config.payload.payload, "RpcResponse")!)).toContain("10 isLeftHanded = 0");
  // Sensor data is not inspected.
  expect(band.gesture(3, 1).some((e) => e.payload.type === "inspection")).toBe(false);
  expect(band.gyro([1, 2, 3], 1_000_000).some((e) => e.payload.type === "inspection")).toBe(false);
});

test("records keep each distinct message once, whatever its request ID", () => {
  const seen: string[] = [];
  const records = new BandRecords((record) => seen.push(record.name), join(mkdtempSync(join(tmpdir(), "kinesis-records-")), "records.json"));
  const reply = (id: number, level: number) => concat(BandWire.field(1, id), BandWire.field(2, 1), BandWire.field(3, BandWire.field(1, BandWire.field(1, level))));
  records.receive(0x8008, 0x02000315, reply(1, 76));
  records.receive(0x8008, 0x02000315, reply(2, 76));
  records.receive(0x8008, 0x02000315, reply(3, 75));
  expect(seen).toEqual(["battery reply", "battery reply"]);
  expect(records.list().map((r) => r.count)).toEqual([2, 1]);
});
