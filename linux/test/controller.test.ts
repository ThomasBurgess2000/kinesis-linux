import { expect, test } from "bun:test";
import { LoggingBackend } from "../src/actions";
import { DEFAULT_CONFIG } from "../src/config";
import type { BandOperation, Logger } from "../src/connection";
import { type ConnectionLike, Controller } from "../src/controller";
import type { BandEvent, BandGesture, BandHand, MotionStreams } from "../src/gestures";

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
  motion: MotionStreams[] = [];
  restarts = 0;
  setMotionStreams(streams: MotionStreams): void {
    this.motion.push(streams);
  }
  restartMotionStreams(): void {
    this.restarts += 1;
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

function gyro(time: number, bandSeconds: number, values: [number, number, number] = [0, 0, 0]): BandEvent {
  return { payload: { type: "gyro", timestampUs: BigInt(Math.round(bandSeconds * 1e6)), values }, receivedAt: time };
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
    connection.emit!(gyro(clock.now, 5 + i * 0.1));
  }
  expect(controller.state.linkCongested).toBe(false);
  // Then 0.5 s late for over a second.
  for (let i = 1; i <= 14; i++) {
    clock.now = 101 + i * 0.1;
    connection.emit!(gyro(clock.now, 6 + i * 0.1 - 0.5));
  }
  expect(controller.state.linkCongested).toBe(true);
  // Back on time for two seconds.
  for (let i = 1; i <= 21; i++) {
    clock.now = 102.4 + i * 0.1;
    connection.emit!(gyro(clock.now, 7.4 + i * 0.1));
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

// --- air cursor ---

class FakePointer {
  moves: [number, number][] = [];
  buttons: string[] = [];
  closed = false;
  move(dx: number, dy: number): void {
    this.moves.push([dx, dy]);
  }
  button(button: string, down: boolean): void {
    this.buttons.push(`${button} ${down ? "down" : "up"}`);
  }
  close(): void {
    this.closed = true;
  }
  get moved(): [number, number] {
    return this.moves.reduce<[number, number]>((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]);
  }
}

async function cursorSetup(developerMode = true) {
  const clock = { now: 100 };
  const connection = new FakeConnection();
  const backend = new LoggingBackend();
  const pointer = new FakePointer();
  const keys: { hooks?: { onEscape(): void; onAlt(held: boolean): void }; stopped: number } = { stopped: 0 };
  const config = { ...structuredClone(DEFAULT_CONFIG), developerMode };
  const controller = new Controller(config, connection, backend, quiet, {}, () => clock.now, {
    openPointer: () => pointer,
    watchKeys: (hooks) => {
      keys.hooks = hooks;
      return { start: () => 1, stop: () => { keys.stopped += 1; } };
    },
    frames: "manual",
  });
  controller.connect(band, { enableControls: true });
  await Bun.sleep(0);
  connection.emit!({ payload: { type: "connected" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "handedness", hand: "right" }, receivedAt: clock.now });
  connection.emit!({ payload: { type: "heartbeat" }, receivedAt: clock.now });
  return { controller, connection, backend, pointer, keys, clock };
}

/// The forearm pointing `azimuth` degrees left of the band's resting heading, level.
function orientation(time: number, bandSeconds: number, azimuth: number): BandEvent {
  const half = azimuth * Math.PI / 360;
  return { payload: { type: "orientation", timestampUs: BigInt(Math.round(bandSeconds * 1e6)), values: [Math.cos(half), 0, 0, Math.sin(half)] }, receivedAt: time };
}

test("the air cursor needs developer mode and live controls, and asks for orientation only while on", async () => {
  const off = await cursorSetup(false);
  expect(off.controller.setAirCursorEnabled(true)).toBe(false);
  expect(off.controller.state.airCursor.available).toBe(false);
  await off.controller.disconnect();

  const { controller, connection, keys } = await cursorSetup();
  expect(controller.state.airCursor.available).toBe(true);
  expect(connection.motion.at(-1)).toEqual({ gyro: true, orientation: false });
  expect(controller.setAirCursorEnabled(true)).toBe(true);
  expect(controller.state.airCursor).toMatchObject({ enabled: true, keys: true });
  expect(connection.motion.at(-1)).toEqual({ gyro: true, orientation: true });
  // Escape turns it off, and the orientation stream with it.
  keys.hooks!.onEscape();
  expect(controller.state.airCursor.enabled).toBe(false);
  expect(keys.stopped).toBe(1);
  expect(connection.motion.at(-1)).toEqual({ gyro: true, orientation: false });
  // Pausing controls turns it off too.
  controller.setAirCursorEnabled(true);
  controller.pause();
  expect(controller.state.airCursor.enabled).toBe(false);
  await controller.disconnect();
});

test("turning the arm moves the pointer; holding it still doesn't", async () => {
  const { controller, connection, pointer, clock } = await cursorSetup();
  controller.setAirCursorEnabled(true);
  // Hold still for half a second, then turn left at 20°/s for half a second, then hold.
  let azimuth = 0;
  for (let i = 0; i < 192; i++) {
    clock.now = 100 + i / 128;
    const turning = i >= 64 && i < 128;
    if (turning) azimuth += 20 / 128;
    connection.emit!(gyro(clock.now, 5 + i / 128, [turning ? 20 / 0.07 : 0, 0, 0]));
    connection.emit!(orientation(clock.now, 5 + i / 128, azimuth));
    controller.cursorFrame();
  }
  for (let i = 0; i < 20; i++) {
    clock.now += 0.01;
    controller.cursorFrame();
  }
  const [x, y] = pointer.moved;
  // Ten degrees to the left at the default 45 points a degree, times the acceleration at 20°/s.
  expect(x).toBeLessThan(-200);
  expect(x).toBeGreaterThan(-10 * 45 * 1.6);
  expect(Math.abs(y)).toBeLessThan(Math.abs(x) * 0.15);
  await controller.disconnect();
});

test("an index pinch clicks and holds for a drag, a middle pinch right-clicks, and thumbs still swipe", async () => {
  const { controller, connection, pointer, backend, clock } = await cursorSetup();
  controller.setAirCursorEnabled(true);
  clock.now = 101;
  connection.emit!(gesture(101, { finger: "index", action: "press", sequence: 1 }));
  expect(pointer.buttons).toEqual(["left down"]);
  expect(controller.state.pinchedFinger).toBe("index");
  // The pinch's own hold report doesn't click again.
  connection.emit!(gesture(101, { finger: "index", action: "press", derived: "buttonHold", sequence: 2 }));
  expect(pointer.buttons).toEqual(["left down"]);
  clock.now = 101.3;
  connection.emit!(gesture(101.3, { finger: "index", action: "release", sequence: 3 }));
  expect(pointer.buttons).toEqual(["left down", "left up"]);
  clock.now = 102;
  connection.emit!(gesture(102, { finger: "middle", action: "press", sequence: 4 }));
  connection.emit!(gesture(102, { finger: "middle", action: "release", sequence: 5 }));
  expect(pointer.buttons.slice(2)).toEqual(["right down", "right up"]);
  // No tap actions while the cursor has the fingers, but a thumb swipe still switches desktops.
  clock.now = 103;
  connection.emit!(gesture(103, { finger: "thumb", action: "left", sequence: 6 }));
  await Bun.sleep(0);
  expect(backend.posted).toEqual(["previousDesktop"]);
  await controller.disconnect();
});

test("late band data lets go of a held button and drops late pinches", async () => {
  const { controller, connection, pointer, clock } = await cursorSetup();
  controller.setAirCursorEnabled(true);
  connection.emit!(gyro(100, 5));
  clock.now = 100.1;
  connection.emit!(gesture(100.1, { finger: "index", action: "press", sequence: 1 }));
  expect(pointer.buttons).toEqual(["left down"]);
  // The band's samples now arrive a second late.
  for (let i = 1; i <= 14; i++) {
    clock.now = 100.1 + i * 0.1;
    connection.emit!(gyro(clock.now, 5.1 + i * 0.1 - 1));
  }
  expect(controller.state.linkCongested).toBe(true);
  expect(pointer.buttons).toEqual(["left down", "left up"]);
  expect(connection.restarts).toBe(1);
  connection.emit!(gesture(clock.now, { finger: "index", action: "press", sequence: 2 }));
  expect(pointer.buttons).toHaveLength(2);
  await controller.disconnect();
});

test("holding Alt parks the pointer and lets go of a drag", async () => {
  const { controller, connection, pointer, keys, clock } = await cursorSetup();
  controller.setAirCursorEnabled(true);
  clock.now = 101;
  connection.emit!(gesture(101, { finger: "index", action: "press", sequence: 1 }));
  keys.hooks!.onAlt(true);
  expect(controller.state.airCursor.repositioning).toBe(true);
  expect(pointer.buttons).toEqual(["left down", "left up"]);
  // Pinches are ignored while parked.
  connection.emit!(gesture(101, { finger: "middle", action: "press", sequence: 2 }));
  expect(pointer.buttons).toHaveLength(2);
  keys.hooks!.onAlt(false);
  expect(controller.state.airCursor.repositioning).toBe(false);
  await controller.disconnect();
});

test("the cursor page asks for orientation and prepares the mouse; closing the band closes it", async () => {
  const { controller, connection, pointer } = await cursorSetup();
  controller.setMotionViewers({ readings: false, cursor: true, log: false });
  expect(connection.motion.at(-1)).toEqual({ gyro: true, orientation: true });
  controller.setMotionViewers({ readings: false, cursor: false, log: false });
  expect(connection.motion.at(-1)).toEqual({ gyro: true, orientation: false });
  await controller.disconnect();
  expect(pointer.closed).toBe(true);
});
