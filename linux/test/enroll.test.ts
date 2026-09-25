import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { BandOperation, Logger } from "../src/connection";
import { type EnrollConnection, type PairProgress, claimBand, isTransientEnrollFailure, isWrongAccount } from "../src/enroll";
import type { BandEvent } from "../src/gestures";
import { type BandEnrollmentIdentity, BandIdentity, SigningKey } from "../src/identity";

const quiet: Logger = { info() {}, notice() {}, error() {} };
const band = { address: "AA:BB:CC:DD:EE:FF", addressType: "public" as const, name: "Meta Band TEST" };
const session = { accessToken: "t", userID: "42", deviceID: "d", obtainedAt: 0 };

beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "kinesis-enroll-"));
});

/// Plays one scripted attempt: the ceremony stages, then either a connected session or a failure.
class ScriptedConnection implements EnrollConnection {
  enrolled: BandEnrollmentIdentity | undefined;
  operations: BandOperation[] = [];
  constructor(private readonly script: { stages?: string[]; adopt?: BandEnrollmentIdentity; fail?: string }) {}
  private onEnd: ((error: Error | undefined) => void) | undefined;
  async start(operation: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void> {
    this.operations.push(operation);
    this.onEnd = onEnd;
    for (const message of this.script.stages ?? []) {
      if (message === "establishing trust" && this.script.adopt) this.enrolled = this.script.adopt;
      onEvent({ payload: { type: "ceremonyStage", message }, receivedAt: 0 });
    }
    if (this.script.fail) { onEnd(new Error(this.script.fail)); return; }
    onEvent({ payload: { type: "connected" }, receivedAt: 0 });
  }
  /// Like BandConnection: stopping ends the connection cleanly.
  stop(): void {
    this.onEnd?.(undefined);
  }
}

test("a claim reports each ceremony stage, saves the key, and ends ready", async () => {
  const identity = { privateKey: SigningKey.generate() };
  const progress: PairProgress[] = [];
  const connection = new ScriptedConnection({
    stages: ["reading the band identity", "claiming the band", "confirming ownership", "establishing trust"], adopt: identity,
  });
  const result = await claimBand({
    band, config: DEFAULT_CONFIG, session, log: quiet, onProgress: (p) => progress.push(p), newConnection: () => connection,
  });
  expect(result).toBe(identity);
  expect(progress.map((p) => p.message)).toEqual([
    "Connecting to your band…", "reading the band identity", "claiming the band", "confirming ownership", "establishing trust",
    "Your band is paired.",
  ]);
  expect(progress.at(-1)?.step).toBe("ready");
  expect(await BandIdentity.exists(band.address)).toBe(true);
  // The first attempt runs the ownership ceremony, not the enrolled trust flow.
  const op = connection.operations[0]!;
  expect(op.kind === "connect" && op.session?.ceremony !== undefined).toBe(true);
});

test("after the band adopts the key, a dropped link retries with that key instead of re-claiming", async () => {
  const identity = { privateKey: SigningKey.generate() };
  const attempts = [
    new ScriptedConnection({ stages: ["establishing trust"], adopt: identity, fail: "The band took too long to respond." }),
    new ScriptedConnection({}),
  ];
  let next = 0;
  const result = await claimBand({
    band, config: DEFAULT_CONFIG, session, log: quiet, onProgress: () => {}, newConnection: () => attempts[next++]!, retryDelayMs: 0,
  });
  expect(result).toBe(identity);
  const retry = attempts[1]!.operations[0]!;
  expect(retry.kind === "connect" && retry.session?.enrollment).toBe(identity);
  expect(retry.kind === "connect" && retry.session?.ceremony).toBeUndefined();
});

test("a ceremony rejection is final, and a wrong account is recognizable", async () => {
  const rejection = "the band rejected enrollment (0x1042). try again.";
  const failing = claimBand({
    band, config: DEFAULT_CONFIG, session, log: quiet, onProgress: () => {},
    newConnection: () => new ScriptedConnection({ stages: ["confirming ownership"], fail: rejection }), retryDelayMs: 0,
  });
  await expect(failing).rejects.toThrow("0x1042");
  expect(isWrongAccount(new Error(rejection))).toBe(true);
  expect(isWrongAccount(new Error("the band rejected enrollment (0x1043). try again."))).toBe(false);
  expect(isTransientEnrollFailure("Connection timed out")).toBe(true);
  expect(isTransientEnrollFailure(rejection)).toBe(false);
});
