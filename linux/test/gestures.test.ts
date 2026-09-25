import { expect, test } from "bun:test";
import { ActionGate, type BandGesture, DialRouter, GestureRouter, type RecognizedGesture, type TapGesture, recognizedLabel } from "../src/gestures";

function gesture(sequence: number, options: { time?: number; action?: string; derived?: string; finger?: string; synthetic?: boolean } = {}): BandGesture {
  return {
    sequence: BigInt(sequence), timestampUs: BigInt(sequence * 1000), finger: options.finger ?? "thumb",
    action: options.action ?? "left", derivedAction: options.derived ?? "unknown",
    synthetic: options.synthetic ?? false, receivedAt: options.time ?? 100,
  };
}
const swipe = (direction: "left" | "right" | "up" | "down"): RecognizedGesture => ({ kind: "swipe", direction });
const tap = (t: TapGesture): RecognizedGesture => ({ kind: "tap", tap: t });

test("one swipe produces one action across raw, derived, and repeated messages", () => {
  const router = new GestureRouter();
  const raw = gesture(1);
  expect(router.gesture(raw, 100.01)).toEqual(swipe("left"));
  expect(router.gesture(raw, 100.02)).toBeUndefined();
  expect(router.gesture(gesture(2, { time: 100.03, action: "unknown", derived: "buttonLeft" }), 100.04)).toBeUndefined();
  expect(router.gesture(gesture(3, { time: 100.5 }), 100.51)).toEqual(swipe("left"));
});

test("derived first and all four directions work", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1, { action: "unknown", derived: "buttonRight" }), 100)).toEqual(swipe("right"));
  expect(router.gesture(gesture(2, { time: 100.02, action: "right" }), 100.03)).toBeUndefined();
  expect(router.gesture(gesture(3, { time: 101, action: "up" }), 101)).toEqual(swipe("up"));
  expect(router.gesture(gesture(4, { time: 102, action: "down" }), 102)).toEqual(swipe("down"));
  expect(router.gesture(gesture(5, { time: 103, action: "left" }), 103)).toEqual(swipe("left"));
});

test("stale, partial, synthetic, and wrong-finger events cannot control the desktop", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1), 101)).toBeUndefined();
  expect(router.gesture(gesture(2, { time: 102 }), 100)).toBeUndefined();
  expect(router.gesture(gesture(3, { action: "partialLeft" }), 100)).toBeUndefined();
  expect(router.gesture(gesture(4, { finger: "index" }), 100)).toBeUndefined();
  expect(router.gesture(gesture(5, { synthetic: true }), 100)).toBeUndefined();
  expect(router.gesture(gesture(6), 100.02)).toEqual(swipe("left"));
});

test("reconnect can restart sequence without replaying stale input", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1), 100)).toEqual(swipe("left"));
  router.reset();
  expect(router.gesture(gesture(1), 200)).toBeUndefined();
  expect(router.gesture(gesture(1, { time: 200 }), 200)).toEqual(swipe("left"));
});

test("enabling does not replay old input and pausing is immediate", () => {
  const gate = new ActionGate();
  expect(gate.allows(100, 100, true, true)).toBe(false);
  gate.arm(100.1);
  expect(gate.allows(100, 100.2, true, true)).toBe(false);
  expect(gate.allows(100.2, 100.2, true, true)).toBe(true);
  expect(gate.allows(100.3, 100.3, true, true)).toBe(false);
  gate.pause();
  expect(gate.allows(101, 101, true, true)).toBe(false);
});

test("permission and live connection are required at dispatch", () => {
  const gate = new ActionGate();
  gate.arm(100);
  expect(gate.allows(101, 101, false, true)).toBe(false);
  expect(gate.allows(101, 101, true, false)).toBe(false);
  expect(gate.allows(101, 102, true, true)).toBe(false);
  expect(gate.allows(102, 102, true, true)).toBe(true);
});

test("double taps are recognized once and partial pinches are ignored", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1, { action: "doubletap", finger: "index" }), 100)).toEqual(tap("indexDoubleTap"));
  expect(router.gesture(gesture(2, { time: 100.03, action: "unknown", derived: "doubleTap", finger: "index" }), 100.04)).toBeUndefined();
  expect(router.gesture(gesture(3, { time: 101, action: "unknown", derived: "doubleTap", finger: "middle" }), 101)).toEqual(tap("middleDoubleTap"));
  expect(router.gesture(gesture(4, { time: 102, action: "partialClick", finger: "index" }), 102)).toBeUndefined();
  expect(router.gesture(gesture(5, { time: 103, action: "doubletap", finger: "middle", synthetic: true }), 103)).toBeUndefined();
});

test("a middle hold is its own gesture; an index hold stays the pinch dial", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1, { action: "hold", finger: "middle" }), 100)).toEqual(tap("middleHold"));
  // The derived copy of the same hold is de-duplicated.
  expect(router.gesture(gesture(2, { time: 100.05, action: "unknown", derived: "buttonHold", finger: "middle" }), 100.05)).toBeUndefined();
  expect(router.gesture(gesture(3, { time: 102, action: "unknown", derived: "buttonHold", finger: "middle" }), 102)).toEqual(tap("middleHold"));
  expect(router.gesture(gesture(4, { time: 103, action: "unknown", derived: "buttonHold", finger: "index" }), 103)).toBeUndefined();
  expect(recognizedLabel(tap("middleHold"))).toBe("Middle hold");
});

test("dial reversal and release do not carry over old movement", () => {
  const dial = new DialRouter();
  expect(dial.turn(1, 1, 100)).toBe(0);
  expect(dial.turn(-1, 1, 100.1)).toBe(0);
  expect(dial.turn(-1, 1, 100.2)).toBe(-1);
  expect(dial.turn(1, 1, 100.3)).toBe(0);
  dial.reset();
  expect(dial.turn(1, 1, 100.4)).toBe(0);
  expect(dial.turn(NaN, 1, 100.5)).toBe(0);
  expect(dial.turn(600, 1, 100.6)).toBe(1);
  expect(dial.turn(0, 1, 100.7)).toBe(0);
});

test("fractional dial input accumulates across rate limit and sensitivity scales", () => {
  for (const sensitivity of [0.5, 1, 2, 4]) {
    const dial = new DialRouter();
    const gate = new ActionGate(0);
    gate.arm(100);
    let sent = 0;
    for (let index = 0; index < 32; index++) {
      const now = 100 + index * 0.04;
      if (gate.allows(now, now, true, true)) sent += dial.turn(0.125, sensitivity, now);
    }
    sent += dial.turn(0, sensitivity, 101.4);
    expect(sent).toBe(Math.trunc(2 * sensitivity));
  }
});

test("releasing or losing motion discards pending dial steps", () => {
  const dial = new DialRouter();
  expect(dial.turn(2, 1, 100)).toBe(1);
  expect(dial.turn(2, 1, 100.01)).toBe(0);
  dial.reset();
  expect(dial.turn(0, 1, 100.1)).toBe(0);
  expect(dial.turn(2, 1, 100.2)).toBe(1);
  expect(dial.turn(2, 1, 100.21)).toBe(0);
  expect(dial.turn(0, 1, 101)).toBe(0);
});

test("a fast dial flick cannot send a burst or queue more volume changes", () => {
  const dial = new DialRouter();
  expect(dial.turn(20, 4, 100)).toBe(1);
  expect(dial.turn(0, 4, 100.1)).toBe(0);
  expect(dial.turn(-20, 4, 100.2)).toBe(-1);
  expect(dial.turn(0, 4, 100.3)).toBe(0);
});

test("interleaved raw and derived gestures are counted once per gesture", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1, { action: "left" }), 100)).toEqual(swipe("left"));
  expect(router.gesture(gesture(2, { time: 100.01, action: "right" }), 100.01)).toEqual(swipe("right"));
  expect(router.gesture(gesture(3, { time: 100.02, action: "unknown", derived: "buttonLeft" }), 100.02)).toBeUndefined();
  expect(router.gesture(gesture(4, { time: 100.03, action: "unknown", derived: "buttonRight" }), 100.03)).toBeUndefined();
  expect(router.gesture(gesture(5, { time: 100.04, action: "left" }), 100.04)).toEqual(swipe("left"));
});

test("gesture identity includes the finger", () => {
  const router = new GestureRouter();
  expect(router.gesture(gesture(1, { action: "tap", finger: "index" }), 100)).toEqual(tap("indexTap"));
  expect(router.gesture(gesture(1, { action: "tap", finger: "middle" }), 100)).toEqual(tap("middleTap"));
});
