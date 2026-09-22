import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MetaAuth, formEscape, urlForm } from "../src/meta-auth";
import { MetaPair } from "../src/meta-pair";

test("expectedCallbackToken is the first 16 hex of SHA-256(request token)", () => {
  const nativeSSOToken = "example-request-token";
  const full = createHash("sha256").update(Buffer.from(nativeSSOToken, "utf8")).digest("hex");
  expect(MetaAuth.expectedCallbackToken(nativeSSOToken)).toBe(full.slice(0, 16));
});

test("callbackMatches compares the 16-char token in constant length", () => {
  const tok = "req";
  const expected = MetaAuth.expectedCallbackToken(tok);
  expect(MetaAuth.callbackMatches(expected, tok)).toBe(true);
  expect(MetaAuth.callbackMatches(expected.slice(0, 15), tok)).toBe(false);
  expect(MetaAuth.callbackMatches(undefined, tok)).toBe(false);
  expect(MetaAuth.callbackMatches("0000000000000000", tok)).toBe(false);
});

test("parses the fb-viewapp callback URL query", () => {
  const url = "fb-viewapp://frl_login?token=abcdef0123456789&blob=SGVsbG8%3D&extra=1";
  const { token, blob } = MetaAuth.parseCallback(url);
  expect(token).toBe("abcdef0123456789");
  expect(blob).toBe("SGVsbG8="); // percent-decoded
});

test("form escaping keeps unreserved characters and percent-encodes the rest", () => {
  expect(formEscape("aZ0-._~")).toBe("aZ0-._~");
  expect(formEscape("a b/c=d&e")).toBe("a%20b%2Fc%3Dd%26e");
  expect(urlForm([["k1", "v 1"], ["k2", "a/b"]])).toBe("k1=v%201&k2=a%2Fb");
});

test("pair_request fields carry the base64 device cert, serial, and additional_data json", () => {
  const session = { accessToken: "tok", userID: "u", deviceID: "d", obtainedAt: 0 };
  const identity = { deviceCertificate: new Uint8Array([1, 2, 3]), serial: "SN123", secondaryCertificate: new Uint8Array([4, 5]) };
  const fields = MetaPair.pairRequestFields({ identity, nonce: new Uint8Array([9, 9]), appPublicKey: new Uint8Array([7]) }, session);
  const map = Object.fromEntries(fields);
  expect(map.serial_number).toBe("SN123");
  expect(map.device_cert).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  expect(map.pair_protocol_version).toBe("3");
  const additional = JSON.parse(map.additional_data!);
  expect(additional.device_nonce).toBe(Buffer.from([9, 9]).toString("base64"));
  expect(additional.app_pubkey).toBe(Buffer.from([7]).toString("base64"));
  expect(additional.secondary_cert).toBe(Buffer.from([4, 5]).toString("base64"));
});

test("response parsing pulls receipts and device key, and flags session failures", () => {
  const pending = MetaPair.parsePending({ pending_ownership_receipt: "R", receipt_signature: Buffer.from([1, 2]).toString("base64") });
  expect(pending.receipt).toBe("R");
  expect(Array.from(pending.signature)).toEqual([1, 2]);
  expect(() => MetaPair.parsePending({})).toThrow();

  const point = new Uint8Array(64).fill(3);
  const final = MetaPair.parseFinal({
    final_ownership_receipt: "F", receipt_signature: Buffer.from([9]).toString("base64"),
    additional_data: { device_ec_public_key: Buffer.from(point).toString("base64") },
  });
  expect(final.receipt).toBe("F");
  expect(final.devicePublicKey && final.devicePublicKey.length).toBe(64);

  expect(MetaPair.isSessionFailure(401, undefined)).toBe(true);
  expect(MetaPair.isSessionFailure(200, { code: 190 })).toBe(true);
  expect(MetaPair.isSessionFailure(200, { code: 1 })).toBe(false);
});
