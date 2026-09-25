import { expect, test } from "bun:test";
import { LoggingBackend } from "../src/actions";
import { DEFAULT_CONFIG } from "../src/config";
import type { BandOperation, Logger } from "../src/connection";
import { type ConnectionLike, Controller } from "../src/controller";
import type { BandEvent, BandGesture, BandHand } from "../src/gestures";

const quiet: Logger = { info() {}, notice() {}, error() {} };

class FakeConnection implements ConnectionLike {
  active = false;
  emit: ((event: BandEvent) => void) | undefined;
  end: ((error: Error | undefined) => void) | undefined;
  stopped = 0;
  hands: BandHand[] = [];
  async start(_: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void> {
    this.active = true;
    this.emit = onEvent;
    this.end = onEnd;
  }
  stop(): void {
    this.stopped += 1;
    this.active = false;
    this.end?.(undefined);
  }
  setHandedness(hand: BandHand): void {
    this.hands.push(hand);
  }
  rawEMG: boolean[] = [];
  setRawEMG(enabled: boolean): void {
    this.rawEMG.push(enabled);
  }
}

const band = { address: "AA:BB:CC:DD:EE:FF", addressType: "random" as const, name: "Meta Band TEST" };

function gesture(time: number, options: { finger?: string; action?: string; derived?: string; sequence?: number } = {}): BandEvent {
  const g: BandGesture = {
    receivedAt: time, finger: options.finger ?? "thumb", action: options.action ?? "left",
    derivedAction: options.derived ?? "unknown", synthetic: false,
    sequence: BigInt(options.sequence ?? Math.round(time * 1000)), timestampUs: BigInt(Math.round(time * 1e6)),
  };
  return { payload: { type: "gesture", gesture: g }, receivedAt: time };
}

async function setup(): Promise<{ controller: Controller; connection: FakeConnection; backend: LoggingBackend; clock: { now: number } }> {
  const clock = { now: 100 };
  const connection = new FakeConnection();
  const backend = new LoggingBackend();
  const config = structuredClone(DEFAULT_CONFIG);
  const controller = new Controller(config, connection, backend, quiet, {}, () => clock.now);
  controller.connect(band, { enableControls: true });
  await Bun.sleep(0);
  connection.emit!({ payload: { type: "connected" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "handedness", hand: "right" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "heartbeat" }, receivedAt: clock.now });
  return { controller, connection, backend, clock };
}

test("controls arm on the first live input and swipes dispatch mapped actions once", async () => {
  const { controller, connection, backend, clock } = await setup();
  expect(controller.state.live).toBe(true);
  expect(controller.state.controlsEnabled).toBe(true);
  clock.now = 100.5;
  connection.emit!(gesture(100.5));
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["previousDesktop"]);
  // The derived duplicate of the same swipe is filtered.
  connection.emit!(gesture(100.52, { action: "unknown", derived: "buttonLeft", sequence: 2 }));
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["previousDesktop"]);
  // A different swipe inside the 0.4 s gate is dropped; after it, it goes through.
  clock.now = 100.7;
  connection.emit!(gesture(100.7, { action: "right", sequence: 3 }));
  clock.now = 101.2;
  connection.emit!(gesture(101.2, { action: "right", sequence: 4 }));
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["previousDesktop", "nextDesktop"]);
  expect(controller.state.gestureCount).toBe(3);
  await controller.disconnect();
});

test("stale gestures and gestures while paused never reach the desktop", async () => {
  const { controller, connection, backend, clock } = await setup();
  clock.now = 101;
  connection.emit!(gesture(100.2));
  await Bun.sleep(0);
  expect(backend.posted).toEqual([]);
  controller.pause();
  connection.emit!(gesture(101, { sequence: 9 }));
  await Bun.sleep(0);
  expect(backend.posted).toEqual([]);
  expect(controller.state.gestureCount).toBe(1);
  await controller.disconnect();
});

test("the dial turns volume with the right-hand sign and reverses for the left hand", async () => {
  const { controller, connection, backend, clock } = await setup();
  connection.emit!({ payload: { type: "dialState", engaged: true }, receivedAt: clock.now });
  clock.now = 100.3;
  connection.emit!({ payload: { type: "dialTurn", rotation: 2 }, receivedAt: 100.3 });
  clock.now = 100.4;
  connection.emit!({ payload: { type: "dialTurn", rotation: 2 }, receivedAt: 100.4 });
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["volumeUp", "volumeUp"]);
  connection.emit!({ payload: { type: "handedness", hand: "left" }, receivedAt: clock.now });
  clock.now = 100.5;
  connection.emit!({ payload: { type: "dialTurn", rotation: 2 }, receivedAt: 100.5 });
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["volumeUp", "volumeUp", "volumeDown"]);
  // An index tap right after a dial step is the release of the turn, not a tap.
  connection.emit!(gesture(100.6, { finger: "index", action: "tap", sequence: 20 }));
  await Bun.sleep(0);
  expect(backend.posted.length).toBe(3);
  await controller.disconnect();
});

test("selecting a hand pauses controls and asks the band, then a confirmation re-enables nothing by itself", async () => {
  const { controller, connection } = await setup();
  expect(controller.canChangeHand).toBe(true);
  controller.selectHand("left");
  expect(connection.hands).toEqual(["left"]);
  expect(controller.state.controlsEnabled).toBe(false);
  expect(controller.state.pendingHand).toBe("left");
  connection.emit!({ payload: { type: "handedness", hand: "left" }, receivedAt: 100 });
  expect(controller.state.bandHand).toBe("left");
  expect(controller.state.pendingHand).toBeUndefined();
  expect(controller.state.handConfirmed).toBe(true);
  await controller.disconnect();
});

test("disconnect stops the connection and stays disconnected", async () => {
  const { controller, connection } = await setup();
  await controller.disconnect();
  expect(connection.stopped).toBeGreaterThanOrEqual(1);
  expect(controller.state.phase).toBe("Disconnected");
  expect(controller.state.live).toBe(false);
});

function motion(time: number, bandSeconds: number): BandEvent {
  return { payload: { type: "motion", bandTimeUs: BigInt(Math.round(bandSeconds * 1e6)) }, receivedAt: time };
}

test("a quiet sensor stream shows a hint and reconnects once; data clears the hint", async () => {
  const { controller, connection, clock } = await setup();
  connection.emit!(motion(100, 5));
  // Status replies keep the link alive, but no motion arrives: at 10 s the hint shows...
  for (let t = 101; t <= 110; t += 0.5) {
    clock.now = t;
    connection.emit!({ payload: { type: "heartbeat" }, receivedAt: t });
    controller["tick"]();
  }
  expect(controller.state.streamHint).toContain("on your wrist");
  expect(connection.stopped).toBe(0);
  // ...and just past it, the one budgeted recovery reconnects.
  clock.now = 110.6;
  connection.emit!({ payload: { type: "heartbeat" }, receivedAt: 110.6 });
  controller["tick"]();
  expect(connection.stopped).toBe(1);
  expect(controller.state.status).toBe("reconnecting");
  controller["tick"]();
  expect(connection.stopped).toBe(1);
  await controller.disconnect();
});

test("after the recovery is spent, a still-quiet band is not reconnected again", async () => {
  const { controller, connection, clock } = await setup();
  controller["sensorRecoveryUsed"] = true;
  connection.emit!(motion(100, 5));
  for (let t = 101; t <= 125; t += 0.5) {
    clock.now = t;
    connection.emit!({ payload: { type: "heartbeat" }, receivedAt: t });
    controller["tick"]();
  }
  expect(connection.stopped).toBe(0);
  expect(controller.state.streamHint).toBeDefined();
  clock.now = 125.2;
  connection.emit!(motion(125.2, 30.2));
  expect(controller.state.streamHint).toBeUndefined();
  await controller.disconnect();
});

test("late band data marks the link congested, and on-time data clears it", async () => {
  const { controller, connection, clock } = await setup();
  // On time: host and band clocks advance together.
  for (let i = 0; i <= 10; i++) {
    clock.now = 100 + i * 0.1;
    connection.emit!(motion(clock.now, 5 + i * 0.1));
  }
  expect(controller.state.linkCongested).toBe(false);
  // Then 0.5 s late for over a second.
  for (let i = 1; i <= 14; i++) {
    clock.now = 101 + i * 0.1;
    connection.emit!(motion(clock.now, 6 + i * 0.1 - 0.5));
  }
  expect(controller.state.linkCongested).toBe(true);
  // Back on time for two seconds.
  for (let i = 1; i <= 21; i++) {
    clock.now = 102.4 + i * 0.1;
    connection.emit!(motion(clock.now, 7.4 + i * 0.1));
  }
  expect(controller.state.linkCongested).toBe(false);
  await controller.disconnect();
});

test("a pending desktop pairing request shows until the band connects", async () => {
  const { controller, connection, clock } = await setup();
  connection.emit!({ payload: { type: "systemPairingPending" }, receivedAt: clock.now });
  expect(controller.state.awaitingSystemPairing).toBe(true);
  connection.emit!({ payload: { type: "connected" }, receivedAt: clock.now });
  expect(controller.state.awaitingSystemPairing).toBe(false);
  await controller.disconnect();
});
