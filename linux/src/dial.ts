// Relative wrist rotation while a fresh index pinch is held.
// Port of Sources/KinesisCore/PinchDial.swift.

import type { BandGesture } from "./gestures";

type Vec3 = [number, number, number];

export class PinchDial {
  engaged = false;
  private pressedAt = new Map<string, number>();
  private lastGyroAt: number | undefined;
  private lastDeviceTime: bigint | undefined;
  private bias: Vec3 = [0, 0, 0];
  private integral: Vec3 = [0, 0, 0];
  private axis: number | undefined;

  tick(now: number): void {
    if (this.lastGyroAt !== undefined && now - this.lastGyroAt >= 0.35) {
      this.pressedAt.clear();
      this.release();
    }
    for (const [finger, time] of [...this.pressedAt]) {
      if (now - time >= 10) {
        this.pressedAt.delete(finger);
        if (finger === "index") this.release();
      }
    }
  }

  gesture(gesture: BandGesture, now: number): void {
    this.tick(now);
    if (gesture.synthetic || !["index", "middle"].includes(gesture.finger)) return;
    const finger = gesture.finger;
    const press = gesture.action === "press" || gesture.derivedAction === "buttonPress";
    const released = gesture.action === "release" || ["buttonRelease", "buttonHoldRelease"].includes(gesture.derivedAction);
    if (press && !this.pressedAt.has(finger)) {
      this.pressedAt.set(finger, now);
      if (finger === "index" && this.lastGyroAt !== undefined && now - this.lastGyroAt < 0.35) {
        this.release();
        this.engaged = true;
      }
    }
    if (released) {
      this.pressedAt.delete(finger);
      if (finger === "index") this.release();
    }
  }

  gyro(timestamp: bigint, values: Vec3, now: number): number | undefined {
    this.tick(now);
    const previous = this.lastDeviceTime;
    this.lastDeviceTime = timestamp;
    this.lastGyroAt = now;
    if (previous === undefined || timestamp <= previous || timestamp - previous > 50_000n) {
      if (this.engaged) {
        this.pressedAt.delete("index");
        this.release();
      }
      return undefined;
    }
    const dt = Number(timestamp - previous) / 1e6;
    if (this.pressedAt.size === 0 && values.every((v, i) => Math.abs(v - this.bias[i]!) < 45)) {
      const blend = 1 - Math.exp(-dt / 2);
      this.bias = this.bias.map((b, i) => b + (values[i]! - b) * blend) as Vec3;
    }
    // Observed 0.07 gyro scale; this remains a relative, experimental estimate.
    const delta = values.map((v, i) => (v - this.bias[i]!) * (0.07 * dt)) as Vec3;
    if (!this.engaged) return undefined;
    this.integral = this.integral.map((v, i) => v + delta[i]!) as Vec3;
    if (this.axis === undefined) {
      let dominant = 0;
      for (let i = 1; i < 3; i++) if (Math.abs(this.integral[i]!) > Math.abs(this.integral[dominant]!)) dominant = i;
      if (Math.abs(this.integral[dominant]!) >= 0.25) {
        this.axis = dominant;
        return this.integral[dominant];
      }
      return undefined;
    }
    return delta[this.axis];
  }

  private release(): void {
    this.engaged = false;
    this.integral = [0, 0, 0];
    this.axis = undefined;
  }
}
