// The motion side of readings and the cursor page, and the developer motion log. Port of
// MotionReadings.swift and MotionLog.swift.

import type { FileSink } from "bun";
import type { ForearmAim } from "./air-cursor";
import type { MotionSample } from "./controller";
import type { BandEvent } from "./gestures";

export interface MotionUpdate {
  /// The gyro trace starts over (a new session, or the first update).
  restart: boolean;
  /// New gyro samples since the last update: [host seconds, x, y, z] in degrees per second.
  gyro: [number, number, number, number][];
  aim: ForearmAim | null;
  /// How fast the arm turns, degrees per second, smoothed over a quarter second.
  armSpeed: number;
  gyroRate: number;
  orientationRate: number;
  /// Seconds late, by the band's own clock.
  delay: number;
}

/// Takes every sample and hands the viewers a batch at most 20 times a second, so a 128 Hz
/// stream never re-renders the page 128 times a second.
export class MotionReadings {
  private pending: [number, number, number, number][] = [];
  private restart = true;
  private aim: ForearmAim | null = null;
  private delay = 0;
  private armSpeed = 0;
  private rateStart: number | undefined;
  private gyroCount = 0;
  private orientationCount = 0;
  private gyroRate = 0;
  private orientationRate = 0;
  private fresh = false;

  receive(sample: MotionSample): void {
    this.fresh = true;
    this.delay = sample.delay;
    if (sample.kind === "gyro") {
      this.pending.push([sample.receivedAt, ...sample.degreesPerSecond]);
      if (this.pending.length > 1024) this.pending.shift();
      this.armSpeed += (sample.armSpeed - this.armSpeed) * (1 - Math.exp(-(1 / 128) / 0.25));
      this.gyroCount += 1;
    } else {
      this.aim = sample.aim;
      this.orientationCount += 1;
    }
    const start = this.rateStart ?? sample.receivedAt;
    this.rateStart = start;
    if (sample.receivedAt - start >= 1) {
      this.gyroRate = this.gyroCount / (sample.receivedAt - start);
      this.orientationRate = this.orientationCount / (sample.receivedAt - start);
      this.rateStart = sample.receivedAt;
      this.gyroCount = 0;
      this.orientationCount = 0;
    }
  }

  /// What arrived since the last call, or undefined when nothing did.
  take(): MotionUpdate | undefined {
    if (!this.fresh && !this.restart) return undefined;
    const update: MotionUpdate = {
      restart: this.restart, gyro: this.pending, aim: this.aim, armSpeed: this.armSpeed,
      gyroRate: this.gyroRate, orientationRate: this.orientationRate, delay: this.delay,
    };
    this.pending = [];
    this.restart = false;
    this.fresh = false;
    return update;
  }

  reset(): void {
    this.pending = [];
    this.restart = true;
    this.aim = null;
    this.delay = 0;
    this.armSpeed = 0;
    this.rateStart = undefined;
    this.gyroCount = 0;
    this.orientationCount = 0;
    this.gyroRate = 0;
    this.orientationRate = 0;
  }
}

/// A developer tool: when KINESIS_MOTION_LOG names a file, every gyro, orientation, and gesture
/// event is appended to it as JSON lines, with both clocks, for offline analysis of the air
/// cursor. While it records, the orientation stream stays on.
export class MotionLog {
  private writer: FileSink | undefined;

  constructor(path = process.env.KINESIS_MOTION_LOG) {
    if (path) this.writer = Bun.file(path).writer();
  }

  get isOn(): boolean {
    return this.writer !== undefined;
  }

  record(event: BandEvent): void {
    const writer = this.writer;
    if (!writer) return;
    const payload = event.payload;
    let row: Record<string, unknown>;
    switch (payload.type) {
      case "gyro":
        row = { at: event.receivedAt, event: "gyro", t: Number(payload.timestampUs), v: payload.values };
        break;
      case "orientation":
        row = { at: event.receivedAt, event: "quat", t: Number(payload.timestampUs), v: payload.values };
        break;
      case "gesture": {
        const g = payload.gesture;
        row = { at: event.receivedAt, event: "gesture", t: Number(g.timestampUs), finger: g.finger, action: g.action, derived: g.derivedAction };
        break;
      }
      default:
        return;
    }
    try {
      writer.write(JSON.stringify(row) + "\n");
    } catch {
      // A full disk or a removed volume ends the log, never the daemon.
      this.writer = undefined;
    }
  }

  async close(): Promise<void> {
    const writer = this.writer;
    this.writer = undefined;
    await writer?.end();
  }
}
