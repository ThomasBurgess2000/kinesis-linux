import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoggingBackend } from "../src/actions";
import { DEFAULT_CONFIG, saveConfig } from "../src/config";
import type { BandOperation, Logger } from "../src/connection";
import type { ConnectionLike } from "../src/controller";
import { Daemon, DaemonError, daemonRunning } from "../src/daemon";
import type { PairProgress } from "../src/enroll";
import type { BandEvent, BandGesture, BandHand } from "../src/gestures";
import { BandIdentity, SigningKey } from "../src/identity";

const quiet: Logger = { info() {}, notice() {}, error() {} };
const band = { address: "AA:BB:CC:DD:EE:FF", addressType: "public" as const, name: "Meta Band TEST" };

class FakeConnection implements ConnectionLike {
  active = false;
  emit: ((event: BandEvent) => void) | undefined;
  end: ((error: Error | undefined) => void) | undefined;
  async start(_: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void> {
    this.active = true;
    this.emit = onEvent;
    this.end = onEnd;
  }
  stop(): void {
    this.active = false;
    this.end?.(undefined);
  }
  setHandedness(_: BandHand): void {}
}

function swipe(time: number, action = "left", sequence = 1): BandEvent {
  const g: BandGesture = {
    receivedAt: time, finger: "thumb", action, derivedAction: "unknown", synthetic: false,
    sequence: BigInt(sequence), timestampUs: BigInt(Math.round(time * 1e6)),
  };
  return { payload: { type: "gesture", gesture: g }, receivedAt: time };
}

/// A socket client that records every message the daemon pushes.
class Client {
  private buffer = "";
  private nextID = 1;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: string }) => void>();
  readonly events: { event: string; data: unknown }[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;

  static async open(path: string): Promise<Client> {
    const client = new Client();
    client.socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_, chunk) => client.received(chunk.toString("utf8")),
      },
    });
    return client;
  }

  private received(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      if (message.event) this.events.push(message);
      else this.pending.get(message.id)?.(message);
    }
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<{ result?: any; error?: string }> {
    const id = this.nextID++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async until(predicate: (event: { event: string; data: any }) => boolean, ms = 2000): Promise<{ event: string; data: any }> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error("event never arrived");
  }

  close(): void {
    this.socket.end();
  }
}

let dir: string;
let daemon: Daemon | undefined;
let clock: { now: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kinesis-daemon-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  clock = { now: 100 };
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

async function startDaemon(options: { withBand?: boolean; connection?: FakeConnection; backend?: LoggingBackend; pairing?: object } = {}) {
  const configPath = join(dir, "config.json");
  const config = structuredClone(DEFAULT_CONFIG);
  if (options.withBand) config.band = band;
  await saveConfig(config, configPath);
  const connection = options.connection ?? new FakeConnection();
  const backend = options.backend ?? new LoggingBackend();
  daemon = new Daemon({
    socketPath: join(dir, "run", "daemon.sock"), configPath, connection, backendFor: () => backend, log: quiet,
    pairing: options.pairing, doctor: async () => [{ name: "Test", ok: true, detail: "fine" }],
    removeFromBluez: async () => {}, clock: () => clock.now,
  });
  await daemon.start();
  const client = await Client.open(join(dir, "run", "daemon.sock"));
  return { client, connection, backend, socket: join(dir, "run", "daemon.sock") };
}

test("serves state and refuses a second daemon on the same socket", async () => {
  const { client, socket } = await startDaemon();
  const reply = await client.call("getState");
  expect(reply.result.controller.status).toBe("disconnected");
  expect(reply.result.band).toBeNull();
  expect(await daemonRunning(socket)).toBe(true);
  const second = new Daemon({ socketPath: socket, configPath: join(dir, "config.json"), connection: new FakeConnection(), log: quiet });
  await expect(second.start()).rejects.toBeInstanceOf(DaemonError);
  expect((await client.call("nope")).error).toContain("Unknown method");
  client.close();
});

test("setConfig rejects bad settings and applies good ones to the live session", async () => {
  const connection = new FakeConnection();
  const backend = new LoggingBackend();
  const { client } = await startDaemon({ withBand: true, connection, backend });
  expect((await client.call("setConfig", { patch: { dial: { sensitivity: 9 } } })).error).toContain("between 0.5 and 4");
  expect((await client.call("setConfig", { patch: { swipes: { left: "launchRockets" } } })).error).toContain("Unknown action");

  const good = await client.call("setConfig", { patch: { swipes: { left: "mute" } } });
  expect(good.result.swipes.left).toBe("mute");
  await client.until((e) => e.event === "config" && e.data.swipes.left === "mute");

  // The running session uses the new mapping without reconnecting.
  connection.emit!({ payload: { type: "connected" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "handedness", hand: "right" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "heartbeat" }, receivedAt: clock.now });
  clock.now = 100.5;
  connection.emit!(swipe(100.5));
  await client.until((e) => e.event === "action");
  expect(backend.posted).toEqual(["mute"]);
  const gesture = await client.until((e) => e.event === "gesture");
  expect(gesture.data).toMatchObject({ kind: "swipe", key: "swipe:left", label: "Swipe left", action: "mute", actionTitle: "Mute / unmute" });
  const state = await client.until((e) => e.event === "state" && e.data.controller.status === "connected");
  expect(state.data.controller.controlsEnabled).toBe(true);
  client.close();
});

test("pairing reports each step and connects with the new identity", async () => {
  const key = SigningKey.generate();
  const steps: PairProgress[] = [];
  const pairing = {
    findBand: async ({ onProgress }: { onProgress: (p: PairProgress) => void }) => {
      onProgress({ step: "find", message: "Hold the band's button until its light flashes." });
      return band;
    },
    obtainMetaSession: async ({ onProgress }: { onProgress: (p: PairProgress) => void }) => {
      onProgress({ step: "signIn", message: "Finish signing in in your browser.", url: "https://auth.meta.com/" });
      return { accessToken: "t", userID: "42", deviceID: "d", obtainedAt: 0 };
    },
    claimBand: async ({ onProgress }: { onProgress: (p: PairProgress) => void }) => {
      onProgress({ step: "claim", message: "claiming the band" });
      const identity = { privateKey: key };
      await BandIdentity.save(identity, band.address);
      return identity;
    },
  };
  const connection = new FakeConnection();
  const { client } = await startDaemon({ connection, pairing });
  await client.call("pairBand");
  const done = await client.until((e) => e.event === "state" && e.data.pairing.step === "ready" && !e.data.pairing.active);
  expect(done.data.band.address).toBe(band.address);
  expect(done.data.enrolled).toBe(true);
  for (const e of client.events) if (e.event === "pairing") steps.push(e.data as PairProgress);
  expect([...new Set(steps.map((s) => s.step))]).toEqual(["find", "signIn", "claim", "ready"]);
  expect(steps.find((s) => s.step === "signIn")?.url).toBe("https://auth.meta.com/");
  expect(connection.active).toBe(true);
  client.close();
});

test("a wrong-account claim failure is reported at the claim step", async () => {
  const pairing = {
    findBand: async () => band,
    obtainMetaSession: async () => ({ accessToken: "t", userID: "42", deviceID: "d", obtainedAt: 0 }),
    claimBand: async ({ onProgress }: { onProgress: (p: PairProgress) => void }) => {
      onProgress({ step: "claim", message: "confirming ownership" });
      throw new Error("the band rejected enrollment (0x1042). try again.");
    },
  };
  const { client } = await startDaemon({ pairing });
  await client.call("pairBand");
  const failed = await client.until((e) => e.event === "state" && e.data.pairing.error !== null);
  expect(failed.data.pairing).toMatchObject({ active: false, failedStep: "claim", wrongAccount: true });
  client.close();
});

test("forget clears the band, its key, and the Meta session", async () => {
  await BandIdentity.save({ privateKey: SigningKey.generate() }, band.address);
  const { client } = await startDaemon({ withBand: true });
  expect((await client.call("getState")).result.enrolled).toBe(true);
  const after = await client.call("forget");
  expect(after.result.band).toBeNull();
  expect(after.result.enrolled).toBe(false);
  expect(await BandIdentity.exists(band.address)).toBe(false);
  expect((await client.call("getConfig")).result.band).toBeUndefined();
  client.close();
});
