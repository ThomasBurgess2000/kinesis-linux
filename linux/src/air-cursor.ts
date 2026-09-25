// The air cursor's pointer model: where the forearm points, how that becomes pointer movement,
// and how it is smoothed and played back. Port of Sources/Kinesis/AirCursor.swift; the numbers
// and their reasons come from upstream's measurements (see its docs/cursor-orientation.md).

import type { BandHand } from "./gestures";

export type Vec2 = [number, number];

const DEGREES = 180 / Math.PI;

/// IEEE remainder: the difference folded into [-y/2, y/2], as Swift's remainder(_:_:).
export function remainder(x: number, y: number): number {
  return x - y * Math.round(x / y);
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const smoothstep = (x: number): number => x * x * (3 - 2 * x);

/// Where the forearm points, from the band's orientation quaternion.
///
/// Measured upstream with guided holds: the quaternion arrives as w, x, y, z, rotates the band's
/// body frame into a world frame whose +z is up (gravity), and the band's body +y runs along the
/// forearm toward the hand. So the forearm's direction in the world gives a compass angle around
/// gravity and an elevation above the horizon, and twisting the wrist changes neither.
export interface ForearmAim {
  /// Degrees around gravity. Positive is counterclockwise seen from above, which is to the left.
  azimuth: number;
  /// Degrees above the horizon.
  elevation: number;
}

/// The band's body axis that runs from the wrist toward the hand. On a left wrist, with the hand
/// set to left, +y points at the elbow instead, while a twist still turns around y. Without the
/// flip a left arm moved the pointer up and down inverted.
export function forearmAxis(hand: BandHand): [number, number, number] {
  return hand === "left" ? [0, -1, 0] : [0, 1, 0];
}

/// The aim for a quaternion in wire order (w, x, y, z), or undefined when it isn't a unit quaternion.
export function forearmAim(values: readonly number[], axis: readonly number[] = [0, 1, 0]): ForearmAim | undefined {
  if (values.length !== 4 || !values.every(Number.isFinite)) return undefined;
  const norm = values.reduce((sum, v) => sum + v * v, 0);
  if (norm < 0.9 || norm > 1.1) return undefined;
  const length = Math.sqrt(norm);
  const w = values[0]! / length, x = values[1]! / length, y = values[2]! / length, z = values[3]! / length;
  const ax = axis[0]!, ay = axis[1]!, az = axis[2]!;
  // v' = v + 2w(q × v) + 2 q × (q × v), with q the vector part.
  const tx = 2 * (y * az - z * ay), ty = 2 * (z * ax - x * az), tz = 2 * (x * ay - y * ax);
  const fx = ax + w * tx + (y * tz - z * ty);
  const fy = ay + w * ty + (z * tx - x * tz);
  const fz = az + w * tz + (x * ty - y * tx);
  const size = Math.hypot(fx, fy, fz);
  return { azimuth: Math.atan2(fy, fx) * DEGREES, elevation: Math.asin(clamp(fz / size, -1, 1)) * DEGREES };
}

/// The 1€ filter (Casiez, Roussel, and Vogel, 2012): heavy smoothing when the value is nearly
/// still, so tremor disappears, and light smoothing when it moves fast, so a real movement is not
/// delayed.
export class OneEuroFilter {
  private value: number | undefined;
  private derivative = 0;

  constructor(private readonly minimumCutoff: number, private readonly beta: number, private readonly derivativeCutoff = 1) {}

  private static smoothing(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(raw: number, dt: number): number {
    const previous = this.value;
    if (previous === undefined || dt <= 0) {
      this.value = raw;
      this.derivative = 0;
      return raw;
    }
    this.derivative += ((raw - previous) / dt - this.derivative) * OneEuroFilter.smoothing(this.derivativeCutoff, dt);
    const cutoff = this.minimumCutoff + this.beta * Math.abs(this.derivative);
    const next = previous + (raw - previous) * OneEuroFilter.smoothing(cutoff, dt);
    this.value = next;
    return next;
  }

  reset(): void {
    this.value = undefined;
    this.derivative = 0;
  }
}

/// Pointer acceleration: slow aiming moves the pointer less, for precision, and a quick flick moves
/// it more, for distance. Slow moves once ran at 0.35 and felt numb; careful moves measured 1.2 to
/// 1.8°/s and flicks over 30°/s. At 2× flicks overshot.
export const PointerAcceleration = {
  slowSpeed: 2,
  fastSpeed: 30,
  slowFactor: 0.6,
  fastFactor: 1.6,
  flickBoosts: [1, 2.5] as const,

  /// The multiplier on the speed at this arm speed in degrees per second.
  factor(speed: number, fast = 1.6): number {
    if (!Number.isFinite(speed)) return this.slowFactor;
    const x = clamp((speed - this.slowSpeed) / (this.fastSpeed - this.slowSpeed), 0, 1);
    return this.slowFactor + (fast - this.slowFactor) * smoothstep(x);
  },
};

/// How the arm was moving when a pinch came.
export type Approach = "still" | "settling" | "tracking";

/// Settings the pointer lab compared upstream. The app uses the defaults.
export interface PointerTuning {
  /// How long the speed that sets acceleration is smoothed over, in seconds. Short, like a mouse:
  /// slowing onto a target drops the boost at once.
  accelerationSeconds: number;
  /// The most a quick move multiplies the speed by.
  fastFactor: number;
  /// How strongly moves are nudged back toward the arm's home: see PointerHome.
  recentering: number;
}

export interface TimedStep {
  time: number;
  step: Vec2;
}

/// Moves the pointer by how the forearm's aim changes, like a mouse, not by where it points. A
/// laser mapping ties every spot on screen to one arm position, so the bottom of the screen meant
/// hitting the desk and every bit of sway moved the pointer. Relative movement with acceleration
/// keeps the arm in a small, comfortable zone.
export class AirPointer {
  /// Near straight up or down the compass angle is meaningless, so it holds still there.
  static readonly steepElevation = 75;
  /// A gap this long in the orientation stream drops the movement across it.
  static readonly maximumGap = 0.5;
  /// Observed scale, not a datasheet value: raw gyro counts to degrees per second.
  static readonly gyroScale = 0.07;
  /// After a pinch the forearm drifts 0.2 to 0.8° over 0.3 s at 2 to 4°/s, and the band's haptic
  /// buzz adds to it. Tracking something that moves ran over 6°/s. So for a moment after a pinch
  /// or a release the stillness threshold rises to this, then fades back over 0.4 s.
  static readonly clickGuard: Vec2 = [3.5, 6];
  static readonly clickGuardSeconds = 0.4;

  // Honing in on a target passed hand tremor straight through at a 3 Hz floor. A 1.2 Hz floor
  // calms slow aiming, and the steeper speed term keeps quick moves crisp.
  private readonly azimuthFilter = new OneEuroFilter(1.2, 0.12);
  private readonly elevationFilter = new OneEuroFilter(1.2, 0.12);
  private unwrappedAzimuth: number | undefined;
  private lastRawAzimuth = 0;
  private lastRawElevation = 0;
  private lastTime: number | undefined;
  /// The filtered aim, once there is one.
  aim: ForearmAim | undefined;
  /// Movement not yet taken, sample by sample, already scaled by stillness and acceleration.
  private pending: TimedStep[] = [];
  /// The gate's view of speed: it rises with the gyro at once and falls over 150 ms, so the
  /// smoothing can finish a quick move after the arm has stopped.
  private gateSpeed = 0;
  private gyroBias: [number, number, number] = [0, 0, 0];
  private lastGyroTime: number | undefined;
  /// Degrees per second the aim is turning, from the gyro, without wrist twist.
  speed = 0;
  /// The last 200 ms of speed, to tell settling onto a target from tracking one.
  private recentSpeeds: { time: number; speed: number }[] = [];
  /// Degrees per second for acceleration, smoothed over `tuning.accelerationSeconds`.
  private accelerationSpeed = 0;
  private clickGuardUntil = -Infinity;
  /// The arm's speed when the guard began. Slowing on from there is still the settle.
  private clickGuardSpeed = 0;

  /// 0 is the most responsive and 1 the steadiest.
  steadiness = 0.5;
  tuning: PointerTuning = { accelerationSeconds: 0.03, fastFactor: PointerAcceleration.fastFactor, recentering: PointerHome.strength };

  /// Below the first value (degrees per second) the arm counts as held still and the pointer
  /// doesn't move; above the second it moves fully. Measured with the gyro smoothed over 100 ms:
  /// holding still ran 0.5°/s typically and 0.9°/s at the 90th percentile, careful moves 1.2 to
  /// 1.8°/s. A positional dead zone gave slow moves backlash instead.
  static still(steadiness: number): Vec2 {
    const low = 0.5 + 0.7 * clamp(steadiness, 0, 1);
    return [low, low + 0.5];
  }

  /// The stillness range at this moment, raised for a while after a pinch.
  stillAt(time: number): Vec2 {
    const base = AirPointer.still(this.steadiness);
    const strength = clamp((this.clickGuardUntil - time) / AirPointer.clickGuardSeconds, 0, 1);
    if (strength <= 0) return base;
    const guardLow = Math.max(AirPointer.clickGuard[0], this.clickGuardSpeed);
    const guardHigh = guardLow + (AirPointer.clickGuard[1] - AirPointer.clickGuard[0]);
    const low = base[0] + (guardLow - base[0]) * strength;
    const high = base[1] + (guardHigh - base[1]) * strength;
    return [low, Math.max(high, low + 0.1)];
  }

  /// People slow down into a click, as with a mouse: pinches made "while moving" came at 5 to
  /// 10°/s and falling from 13 to 24°/s 200 ms before. Tracking something that moves keeps its speed.
  get approach(): Approach {
    if (this.speed < 3) return "still";
    const peak = this.recentSpeeds.reduce((max, s) => Math.max(max, s.speed), this.speed);
    return this.speed < 15 && this.speed < peak * 0.8 ? "settling" : "tracking";
  }

  /// A pinch or release happened: absorb the drift that follows it. The guard starts at the arm's
  /// speed, so slowing on after the pinch moves nothing and speeding up again, as for a drag, gets
  /// through. The smoothing's lag is dropped too; it would carry the pointer on past the click.
  guardClick(time: number): void {
    this.clickGuardUntil = time + AirPointer.clickGuardSeconds;
    this.clickGuardSpeed = this.speed;
    const azimuth = this.unwrappedAzimuth;
    if (azimuth === undefined) return;
    this.azimuthFilter.reset();
    this.elevationFilter.reset();
    this.aim = { azimuth: this.azimuthFilter.filter(azimuth, 0), elevation: this.elevationFilter.filter(this.lastRawElevation, 0) };
    this.pending = [];
  }

  /// How much of the aim's movement reaches the pointer at this moment: 0 held still, 1 moving.
  motion(time: number): number {
    const [low, high] = this.stillAt(time);
    // During a click guard the arm's own speed decides: the held-over speed that lets the
    // smoothing finish a flick would let it finish past the click instead.
    const judged = time < this.clickGuardUntil ? this.speed : this.gateSpeed;
    return smoothstep(clamp((judged - low) / (high - low), 0, 1));
  }

  /// One gyro sample in raw counts. Only its rate is used: the orientation says where the forearm
  /// points, and the gyro says whether it is moving.
  receiveGyro(raw: readonly number[], time: number): void {
    if (raw.length !== 3 || !raw.every(Number.isFinite)) return;
    const dt = this.lastGyroTime === undefined ? 0 : time - this.lastGyroTime;
    this.lastGyroTime = time;
    if (!(dt > 0 && dt < AirPointer.maximumGap)) return;
    const [bx, by, bz] = this.gyroBias;
    const cx = raw[0]! * AirPointer.gyroScale - bx, cy = raw[1]! * AirPointer.gyroScale - by, cz = raw[2]! * AirPointer.gyroScale - bz;
    // The resting offset drifts. Learn it only while the arm is clearly still.
    if (Math.hypot(cx, cy, cz) < 0.8) {
      const learn = 1 - Math.exp(-dt / 4);
      this.gyroBias = [bx + cx * learn, by + cy * learn, bz + cz * learn];
    }
    // Body +y is the forearm, so a rate around y is a twist, which never moves the pointer.
    const rate = Math.hypot(cx, cz);
    this.speed += (rate - this.speed) * (1 - Math.exp(-dt / 0.1));
    this.accelerationSpeed += (rate - this.accelerationSpeed) * (1 - Math.exp(-dt / this.tuning.accelerationSeconds));
    this.gateSpeed = Math.max(this.speed, this.gateSpeed * Math.exp(-dt / 0.15));
    this.recentSpeeds.push({ time, speed: this.speed });
    while (this.recentSpeeds.length && time - this.recentSpeeds[0]!.time > 0.2) this.recentSpeeds.shift();
  }

  /// One orientation sample. Returns false after a gap, whose movement is dropped.
  receive(sample: ForearmAim, time: number): boolean {
    const gap = this.lastTime === undefined ? Infinity : time - this.lastTime;
    if (!(gap > 0)) return true;
    this.lastTime = time;
    if (gap > AirPointer.maximumGap || this.unwrappedAzimuth === undefined) {
      this.azimuthFilter.reset();
      this.elevationFilter.reset();
      this.unwrappedAzimuth = sample.azimuth;
      this.lastRawAzimuth = sample.azimuth;
      this.lastRawElevation = sample.elevation;
      this.pending = [];
      this.aim = { azimuth: this.azimuthFilter.filter(sample.azimuth, 0), elevation: this.elevationFilter.filter(sample.elevation, 0) };
      return false;
    }
    // Keep the compass angle continuous across ±180°, and freeze it where it is undefined.
    if (Math.abs(sample.elevation) < AirPointer.steepElevation) {
      this.unwrappedAzimuth += remainder(sample.azimuth - this.lastRawAzimuth, 360);
    }
    this.lastRawAzimuth = sample.azimuth;
    this.lastRawElevation = sample.elevation;
    const next = {
      azimuth: this.azimuthFilter.filter(this.unwrappedAzimuth, gap),
      elevation: this.elevationFilter.filter(sample.elevation, gap),
    };
    const previous = this.aim;
    if (previous) {
      // Scale each step by the speed at that moment, so a flick keeps its gain even when the
      // pointer is read a frame later.
      const scale = this.motion(time) * PointerAcceleration.factor(this.accelerationSpeed, this.tuning.fastFactor);
      const moved: Vec2 = [(next.azimuth - previous.azimuth) * scale, (next.elevation - previous.elevation) * scale];
      if (moved[0] !== 0 || moved[1] !== 0) this.pending.push({ time, step: moved });
    }
    this.aim = next;
    return true;
  }

  /// Degrees of movement since the last call, after stillness and acceleration: compass (positive
  /// is left) and elevation (positive is up). Undefined until there is an aim.
  movement(): Vec2 | undefined {
    const steps = this.timedMovement();
    return steps?.reduce<Vec2>((sum, s) => [sum[0] + s.step[0], sum[1] + s.step[1]], [0, 0]);
  }

  /// The same movement, with when the band sampled each step, for smooth playback.
  timedMovement(): TimedStep[] | undefined {
    if (!this.aim) return undefined;
    const steps = this.pending;
    this.pending = [];
    return steps;
  }

  /// Drops any movement not yet taken, such as the twitch of a pinch.
  discard(): void {
    this.pending = [];
  }
}

/// Plays the pointer's movement back smoothly, a fixed moment behind the arm. The band's samples
/// arrive in batches every 15 ms, sometimes 30 ms, so posting whatever arrived each frame looked
/// choppy. Each step is placed at the time the band sampled it, and each frame takes the movement
/// up to `seconds` ago, part of a step when the frame falls between two samples.
export class PointerPacer {
  static readonly playbackSeconds = 0.03;
  private steps: { start: number; end: number; points: Vec2 }[] = [];
  private takenUntil = -Infinity;

  /// 0 posts everything at once.
  constructor(readonly seconds: number) {}

  /// Movement the band sampled at `time`. It spans the time since the sample before.
  add(points: Vec2, time: number): void {
    const previous = this.steps.length ? this.steps[this.steps.length - 1]!.end : this.takenUntil;
    const end = Math.max(time, previous);
    this.steps.push({ start: Math.max(previous, end - 1 / 64), end, points: [...points] });
  }

  /// The points to post for a frame shown at `now`, or undefined when the step is too small to move.
  take(now: number): Vec2 | undefined {
    const until = this.seconds > 0 ? now - this.seconds : Infinity;
    const total: Vec2 = [0, 0];
    while (this.steps.length) {
      const first = this.steps[0]!;
      if (first.end <= until) {
        total[0] += first.points[0];
        total[1] += first.points[1];
        this.steps.shift();
        this.takenUntil = Math.max(this.takenUntil, first.end);
        continue;
      }
      const from = Math.max(first.start, this.takenUntil);
      if (until > from) {
        const share = (until - from) / (first.end - from);
        const part: Vec2 = [first.points[0] * share, first.points[1] * share];
        total[0] += part[0];
        total[1] += part[1];
        first.points = [first.points[0] - part[0], first.points[1] - part[1]];
        this.takenUntil = until;
      }
      break;
    }
    if (Math.abs(total[0]) + Math.abs(total[1]) < 0.05) {
      // Keep a tiny remainder for the next frame instead of losing it.
      if ((total[0] !== 0 || total[1] !== 0) && this.steps.length) {
        this.steps[0]!.points = [this.steps[0]!.points[0] + total[0], this.steps[0]!.points[1] + total[1]];
      }
      return undefined;
    }
    return total;
  }

  clear(): void {
    this.steps = [];
  }
}

/// Keeps the pointer and the arm from drifting apart. With acceleration, a move's gain depends on
/// its speed, and an arm doesn't move at the same speed both ways, so over time the arm walks away
/// from where it started. A mouse is lifted and set down again; an arm can't be. So the arm's
/// direction when the cursor turned on is home: while the arm moves, a move back toward home gets
/// up to `strength` more gain and a move away that much less, most when far from home. The
/// pointer never moves on its own, so the correction is hard to notice.
export class PointerHome {
  static readonly strength = 0.25;
  /// How far off, in degrees, gets the full correction.
  static readonly fullDegrees = 12;
  /// The pointer's position less the arm's direction, both in screen degrees, at home.
  private home: Vec2 | undefined;

  reset(): void {
    this.home = undefined;
  }

  /// The pointer is held at a screen edge on this axis: where the arm is now is home.
  rehome(axis: 0 | 1, pointer: Vec2, arm: Vec2): void {
    if (this.home) this.home[axis] = pointer[axis] - arm[axis];
  }

  /// Adjusts one step. `pointer` and `arm` are in screen degrees.
  adjust(step: Vec2, pointer: Vec2, arm: Vec2, strength: number): Vec2 {
    const offset: Vec2 = [pointer[0] - arm[0], pointer[1] - arm[1]];
    if (!this.home) {
      this.home = offset;
      return step;
    }
    const adjusted: Vec2 = [...step];
    for (const axis of [0, 1] as const) {
      const off = offset[axis] - this.home[axis];
      if (step[axis] === 0 || off === 0) continue;
      const amount = strength * Math.min(1, Math.abs(off) / PointerHome.fullDegrees);
      // A step against the offset brings the pointer back toward home.
      adjusted[axis] *= step[axis] * off < 0 ? 1 + amount : 1 - amount;
    }
    return adjusted;
  }
}

/// How the arm's natural across and up lines slant, so a move along them comes out straight on
/// screen. Upstream measures this with a lab-only calibration; the app uses the standard slant.
export class PointerReach {
  constructor(readonly upTilt = 0, readonly acrossTilt = 0) {}

  /// A right arm moving "straight up" drifts left, toward the body: an elbow doesn't hinge in a
  /// straight screen line. A left arm stays at zero until it has been measured.
  static standard(hand: BandHand): PointerReach {
    return new PointerReach(hand === "right" ? 0.1 : 0);
  }

  /// Points the pointer moves per degree of arm turn before acceleration, the same on every
  /// display, like a mouse. 45 scored best upstream: 75° crosses a 3440-point ultrawide.
  static readonly standardSpeed = 45;
  static readonly speeds: Vec2 = [20, 100];

  /// Straightens an aim change (compass, positive left; elevation, positive up) into degrees along
  /// the screen: right and down.
  screenDegrees(aim: Vec2): Vec2 {
    const scale = 1 + this.upTilt * this.acrossTilt;
    const right = -(aim[0] - this.upTilt * aim[1]) / scale;
    const up = (this.acrossTilt * aim[0] + aim[1]) / scale;
    return [right, -up];
  }
}
