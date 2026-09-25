// Port of upstream's AirCursorTests: the forearm's aim, the pointer model, playback, and home.

import { expect, test } from "bun:test";
import {
  AirPointer, type ForearmAim, PointerAcceleration, PointerHome, PointerPacer, PointerReach, type Vec2, forearmAim, forearmAxis,
  remainder,
} from "../src/air-cursor";

const radians = (degrees: number): number => degrees * Math.PI / 180;

type Quaternion = [number, number, number, number];
const about = (degrees: number, axis: [number, number, number]): Quaternion => {
  const half = radians(degrees) / 2;
  return [Math.cos(half), axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half)];
};
const times = (a: Quaternion, b: Quaternion): Quaternion => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

/// The band's quaternion in wire order w, x, y, z, for a forearm turned `azimuth` degrees left of
/// the band's resting heading, raised `elevation` degrees, and twisted `twist` around its length.
function bandQuaternion(azimuth = 0, elevation = 0, twist = 0): Quaternion {
  return times(times(about(azimuth, [0, 0, 1]), about(elevation, [1, 0, 0])), about(twist, [0, 1, 0]));
}

const close = (a: number, b: number, tolerance = 1e-9): boolean => Math.abs(a - b) < tolerance;

test("the forearm aim follows turning and raising and ignores twisting", () => {
  const rest = forearmAim(bandQuaternion())!;
  // At rest the band's +y, the forearm, lies along the world's +y.
  expect(close(rest.azimuth, 90) && close(rest.elevation, 0)).toBe(true);
  expect(close(forearmAim(bandQuaternion(30))!.azimuth, 120)).toBe(true); // counterclockwise from above is left
  const raised = forearmAim(bandQuaternion(0, 20))!;
  expect(close(raised.elevation, 20) && close(raised.azimuth, 90)).toBe(true);
  for (const [azimuth, elevation] of [[0, 0], [45, 15], [-60, -30]] as const) {
    const aim = forearmAim(bandQuaternion(azimuth, elevation))!;
    const twisted = forearmAim(bandQuaternion(azimuth, elevation, 70))!;
    expect(close(aim.azimuth, twisted.azimuth) && close(aim.elevation, twisted.elevation)).toBe(true);
  }
  // A negated quaternion is the same rotation.
  const negated = forearmAim(bandQuaternion(30, 10).map((v) => -v))!;
  expect(close(negated.azimuth, 120) && close(negated.elevation, 10)).toBe(true);
  expect(forearmAim([2, 0, 0, 0])).toBeUndefined();
  expect(forearmAim([Number.NaN, 0, 0, 0])).toBeUndefined();
});

test("a left wrist's band points its axis at the elbow", () => {
  // Measured on a left wrist: forearm raised 40°, the band's +y points 40° down.
  const left = forearmAim(bandQuaternion(0, -40), forearmAxis("left"))!;
  expect(close(left.elevation, 40)).toBe(true);
  // Turning left still turns the compass angle left, as on a right wrist.
  const turned = forearmAim(bandQuaternion(20, -40), forearmAxis("left"))!;
  expect(close(remainder(turned.azimuth - left.azimuth, 360), 20)).toBe(true);
});

/// Feeds the pointer at 128 Hz, like the band does, and adds up the movement it reports, in
/// degrees: positive x is left, positive y is up.
class Feed {
  readonly pointer = new AirPointer();
  time = 0;
  moved: Vec2 = [0, 0];
  private last: ForearmAim | undefined;
  /// Gyro noise in degrees per second, like the resting sensor.
  noise = 0.3;

  constructor(steadiness = 0) {
    this.pointer.steadiness = steadiness;
  }

  sample(aim: ForearmAim): void {
    this.time += 1 / 128;
    // The gyro reports how fast the aim turns, on an axis other than the forearm.
    const last = this.last;
    const rate = last ? Math.hypot(remainder(aim.azimuth - last.azimuth, 360), aim.elevation - last.elevation) * 128 : 0;
    const jitter = this.noise * Math.sin(this.time * 97);
    this.pointer.receiveGyro([(rate + jitter) / AirPointer.gyroScale, 0, jitter / AirPointer.gyroScale], this.time);
    this.last = aim;
    this.pointer.receive(aim, this.time);
    const step = this.pointer.movement() ?? [0, 0];
    this.moved = [this.moved[0] + step[0], this.moved[1] + step[1]];
  }

  sweep(start: ForearmAim, end: ForearmAim, seconds: number): void {
    const steps = Math.max(1, Math.round(seconds * 128));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      this.sample({ azimuth: start.azimuth + (end.azimuth - start.azimuth) * t, elevation: start.elevation + (end.elevation - start.elevation) * t });
    }
    for (let i = 0; i < 64; i++) this.sample(end);
  }

  hold(aim: ForearmAim, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 128); i++) this.sample(aim);
  }
}

const length = (v: Vec2): number => Math.hypot(v[0], v[1]);

test("movement is how far the aim turned, and nothing while it holds", () => {
  const feed = new Feed();
  feed.hold({ azimuth: 90, elevation: 10 }, 0.5);
  expect(length(feed.moved)).toBeLessThan(1e-9);
  feed.moved = [0, 0];
  feed.sweep({ azimuth: 90, elevation: 10 }, { azimuth: 100, elevation: 15 }, 0.5);
  // Ten left and five up, scaled by the acceleration at about 22°/s, in the same direction.
  const factor = PointerAcceleration.factor(Math.hypot(10, 5) / 0.5);
  expect(feed.moved[0]).toBeGreaterThan(10 * factor * 0.8);
  expect(feed.moved[0]).toBeLessThan(10 * factor * 1.05);
  expect(Math.abs(feed.moved[0] / feed.moved[1] - 2)).toBeLessThan(0.05);
});

test("movement is continuous across the compass seam", () => {
  const feed = new Feed();
  feed.hold({ azimuth: 178, elevation: 0 }, 0.5);
  feed.sweep({ azimuth: 178, elevation: 0 }, { azimuth: 182, elevation: 0 }, 0.2);
  // The compass reads −178° at the end: further left, not 356° right.
  expect(feed.moved[0]).toBeGreaterThan(3);
  expect(feed.moved[0]).toBeLessThan(4 * PointerAcceleration.fastFactor);
});

test("a gap in the stream drops the movement across it", () => {
  const feed = new Feed();
  feed.hold({ azimuth: 90, elevation: 0 }, 0.5);
  feed.time += 1;
  feed.hold({ azimuth: 130, elevation: 0 }, 0.5);
  expect(length(feed.moved)).toBeLessThan(1e-9);
});

test("near straight up the compass angle holds still", () => {
  const feed = new Feed();
  feed.hold({ azimuth: 90, elevation: 80 }, 0.5);
  feed.sweep({ azimuth: 90, elevation: 80 }, { azimuth: -20, elevation: 80 }, 1);
  expect(Math.abs(feed.moved[0])).toBeLessThan(1e-9);
});

test("a held arm stays still and a slow move still moves", () => {
  // A held arm: 0.06° of 2 Hz sway, turning at under 0.9°/s like the measured hold.
  const held = new Feed(0.5);
  held.hold({ azimuth: 90, elevation: 0 }, 1);
  for (let i = 0; i < 3 * 128; i++) {
    const t = held.time + 1 / 128;
    held.sample({ azimuth: 90 + 0.06 * Math.sin(2 * Math.PI * 2 * t), elevation: 0 });
  }
  expect(length(held.moved)).toBeLessThan(0.02);
  // A careful move at 1.5°/s, like the measured slow moves, gets through at the slow gain.
  const slow = new Feed(0.5);
  slow.hold({ azimuth: 90, elevation: 0 }, 1);
  slow.sweep({ azimuth: 90, elevation: 0 }, { azimuth: 93, elevation: 0 }, 2);
  expect(slow.moved[0]).toBeGreaterThan(3 * PointerAcceleration.slowFactor * 0.85);
  expect(slow.moved[0]).toBeLessThan(3 * PointerAcceleration.slowFactor * 1.05);
});

test("the click guard absorbs the pinch drift but lets tracking through", () => {
  // The measured drift after a pinch: about 0.6° over 0.3 s, at 2 to 4°/s.
  const drift = new Feed(0.5);
  drift.hold({ azimuth: 90, elevation: 0 }, 1);
  drift.pointer.guardClick(drift.time);
  drift.sweep({ azimuth: 90, elevation: 0 }, { azimuth: 90.6, elevation: 0 }, 0.25);
  expect(Math.abs(drift.moved[0])).toBeLessThan(0.05);
  // Without the guard, the same drift reaches the pointer.
  const unguarded = new Feed(0.5);
  unguarded.hold({ azimuth: 90, elevation: 0 }, 1);
  unguarded.sweep({ azimuth: 90, elevation: 0 }, { azimuth: 90.6, elevation: 0 }, 0.25);
  expect(unguarded.moved[0]).toBeGreaterThan(0.2);
  // Tracking at 15°/s through the same moment keeps most of its movement.
  const tracking = new Feed(0.5);
  tracking.hold({ azimuth: 90, elevation: 0 }, 1);
  tracking.pointer.guardClick(tracking.time);
  tracking.sweep({ azimuth: 90, elevation: 0 }, { azimuth: 96, elevation: 0 }, 0.4);
  expect(tracking.moved[0]).toBeGreaterThan(PointerAcceleration.factor(15) * 6 * 0.7);
});

test("acceleration gives precision when slow and distance when fast", () => {
  expect(PointerAcceleration.factor(0)).toBe(PointerAcceleration.slowFactor);
  expect(PointerAcceleration.factor(1000)).toBe(PointerAcceleration.fastFactor);
  const speeds = Array.from({ length: 61 }, (_, i) => PointerAcceleration.factor(i));
  expect(speeds.every((v, i) => i === 0 || speeds[i - 1]! <= v)).toBe(true);
  // A slow move reports a low speed and a flick a high one.
  const slow = new Feed(), fast = new Feed();
  slow.hold({ azimuth: 90, elevation: 0 }, 0.5);
  fast.hold({ azimuth: 90, elevation: 0 }, 0.5);
  const start = slow.time;
  for (let i = 0; i < 128; i++) slow.sample({ azimuth: 90 + (slow.time - start), elevation: 0 }); // 1°/s
  let fastest = 0;
  for (let step = 1; step <= 32; step++) {
    fast.sample({ azimuth: 90 + 20 * step / 32, elevation: 0 });
    fastest = Math.max(fastest, fast.pointer.speed);
  }
  expect(slow.pointer.speed).toBeLessThan(PointerAcceleration.slowSpeed);
  expect(fastest).toBeGreaterThan(PointerAcceleration.fastSpeed);
});

test("straightening turns the arm's natural lines into screen lines", () => {
  const reach = new PointerReach(0.23, 0.03);
  // Along the arm's natural up line: straight up on screen.
  const up = reach.screenDegrees([0.23, 1]);
  expect(Math.abs(up[0])).toBeLessThan(1e-9);
  expect(up[1]).toBeLessThan(0);
  // Along its natural across line to the right: straight right.
  const right = reach.screenDegrees([-1, 0.03]);
  expect(Math.abs(right[1])).toBeLessThan(1e-9);
  expect(right[0]).toBeGreaterThan(0);
  expect(PointerReach.standard("left").upTilt).toBe(0);
});

test("the pacer plays batches back evenly at any refresh rate", () => {
  for (const refresh of [60, 82, 100, 144]) {
    // The arm moves 1 point per 128 Hz sample. Two samples arrive together every 15 ms, and
    // every fifth batch after 30 ms.
    const pacer = new PointerPacer(PointerPacer.playbackSeconds);
    let sample = 0, arrival = 0, batches = 0, frame = 0;
    const steps: number[] = [];
    while (frame < 2) {
      frame += 1 / refresh;
      while (arrival <= frame) {
        while (sample / 128 <= arrival) {
          pacer.add([1, 0], sample / 128);
          sample += 1;
        }
        batches += 1;
        arrival += batches % 5 === 0 ? 0.03 : 0.015;
      }
      steps.push(pacer.take(frame)?.[0] ?? 0);
    }
    const expected = 128 / refresh;
    const settled = steps.slice(10);
    // Posted as it arrived, frames would move 0, 2 or 4 points. Played back, nearly every frame
    // moves 128 points a second times its length, and none stalls. (The daemon posts every 4 ms;
    // the compositor adds those up per display frame, which is this same sampling.)
    expect(settled.filter((s) => Math.abs(s - expected) < expected * 0.05).length).toBeGreaterThan(settled.length * 0.85);
    expect(settled.filter((s) => Math.abs(s - expected) < expected * 0.5).length).toBeGreaterThan(settled.length * 0.95);
    expect(Math.abs(steps.reduce((a, b) => a + b, 0) - sample)).toBeLessThan(8);
  }
});

test("the pacer drops what is waiting on a click, and with no delay posts everything", () => {
  const paced = new PointerPacer(PointerPacer.playbackSeconds);
  paced.add([5, 0], 1);
  paced.clear();
  expect(paced.take(2)).toBeUndefined();
  const immediate = new PointerPacer(0);
  immediate.add([4, -2], 1);
  expect(immediate.take(1)).toEqual([4, -2]);
  immediate.add([0.01, 0], 1.01);
  expect(immediate.take(1.01)).toBeUndefined();
});

test("home nudges moves back toward where the arm started", () => {
  const home = new PointerHome();
  // The first step sets home and passes through.
  expect(home.adjust([1, 1], [10, 5], [0, 0], 0.25)).toEqual([1, 1]);
  // At home, nothing changes.
  expect(home.adjust([2, -1], [10, 5], [0, 0], 0.25)).toEqual([2, -1]);
  // The pointer has drifted 12° right of the arm: a move left gets more, a move right less.
  const left = home.adjust([-1, 0], [22, 5], [0, 0], 0.25);
  const right = home.adjust([1, 0], [22, 5], [0, 0], 0.25);
  expect(close(left[0], -1.25) && close(right[0], 0.75)).toBe(true);
  // Halfway off, half as much.
  expect(close(home.adjust([-1, 0], [16, 5], [0, 0], 0.25)[0], -1.125)).toBe(true);
  // Held at a screen edge, where the arm is becomes home on that axis.
  home.rehome(0, [22, 5], [0, 0]);
  expect(home.adjust([-1, 0], [22, 5], [0, 0], 0.25)).toEqual([-1, 0]);
});
