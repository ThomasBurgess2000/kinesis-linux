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
