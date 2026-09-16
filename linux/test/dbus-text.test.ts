import { expect, test } from "bun:test";
import { DbusParseError, asMap, getBoolean, getNumber, getString, getStrings, parseReply, tokenize } from "../src/dbus-text";

// Captured from `busctl call ... GetAll s org.bluez.Device1` for an advertising phone.
// This a{qv} ManufacturerData entry is what makes busctl's --json mode fail.
const DEVICE = `a{sv} 16 "Address" s "57:99:E5:5E:A9:DC" "AddressType" s "random" "Alias" s "57-99-E5-5E-A9-DC" "Paired" b false "Bonded" b false "Trusted" b false "Blocked" b false "LegacyPairing" b false "CablePairing" b false "RSSI" n -83 "Connected" b false "UUIDs" as 0 "Adapter" o "/org/bluez/hci0" "ManufacturerData" a{qv} 1 76 ay 20 9 8 19 25 192 168 1 136 27 88 22 8 0 100 1 140 220 103 34 16 "ServicesResolved" b false "AdvertisingFlags" ay 1 26`;

test("parses a device property dictionary including a{qv} manufacturer data", () => {
  const [value] = parseReply(DEVICE);
  const props = asMap(value);
  expect(props.size).toBe(16);
  expect(getString(props, "Address")).toBe("57:99:E5:5E:A9:DC");
  expect(getString(props, "AddressType")).toBe("random");
  expect(getNumber(props, "RSSI")).toBe(-83);
  expect(getBoolean(props, "Paired")).toBe(false);
  expect(getStrings(props, "UUIDs")).toEqual([]);
  const manufacturer = asMap(props.get("ManufacturerData"));
  const apple = manufacturer.get(76);
  expect(apple).toBeInstanceOf(Uint8Array);
  expect((apple as Uint8Array).length).toBe(20);
  expect(props.get("AdvertisingFlags")).toEqual(new Uint8Array([26]));
});

test("parses the managed object tree shape and characteristic values", () => {
  const tree = `a{oa{sa{sv}}} 2 "/org/bluez/hci0" 1 "org.bluez.Adapter1" 2 "Address" s "C8:58:C0:A7:1A:E7" "Powered" b true "/org/bluez/hci0/dev_AA_BB/service0010/char0011" 1 "org.bluez.GattCharacteristic1" 3 "UUID" s "2d41da7c-82b6-42aa-b34e-e2e01df8cc1a" "Value" ay 2 255 0 "Flags" as 2 "read" "notify"`;
  const [value] = parseReply(tree);
  const objects = asMap(value);
  const adapter = asMap(asMap(objects.get("/org/bluez/hci0")).get("org.bluez.Adapter1"));
  expect(getBoolean(adapter, "Powered")).toBe(true);
  const char = asMap(asMap(objects.get("/org/bluez/hci0/dev_AA_BB/service0010/char0011")).get("org.bluez.GattCharacteristic1"));
  expect(getString(char, "UUID")).toBe("2d41da7c-82b6-42aa-b34e-e2e01df8cc1a");
  expect(char.get("Value")).toEqual(new Uint8Array([255, 0]));
  expect(getStrings(char, "Flags")).toEqual(["read", "notify"]);
  expect(parseReply("ay 2 255 0")).toEqual([new Uint8Array([255, 0])]);
  expect(parseReply('s "Meta Band 00BC"')).toEqual(["Meta Band 00BC"]);
  expect(parseReply("y 85")).toEqual([85]);
});

test("handles escapes, structs, empty replies, and rejects malformed output", () => {
  expect(tokenize('s "a \\"quoted\\" word" n 3')).toEqual(["s", '"a \\"quoted\\" word"', "n", "3"]);
  expect(parseReply('as 2 "x" "y \\"z\\""')).toEqual([["x", 'y "z"']]);
  expect(parseReply("(sib) \"name\" 7 true")).toEqual([["name", 7, true]]);
  expect(parseReply("a(sq) 2 \"a\" 1 \"b\" 2")).toEqual([[["a", 1], ["b", 2]]]);
  expect(parseReply("")).toEqual([]);
  expect(() => parseReply('s "unterminated')).toThrow(DbusParseError);
  expect(() => parseReply("b maybe")).toThrow(DbusParseError);
  expect(() => parseReply("ay 3 1 2")).toThrow(DbusParseError);
  expect(() => parseReply("n 1 2")).toThrow(DbusParseError);
});
