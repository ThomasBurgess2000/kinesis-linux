// Gesture types, de-duplication, dial step routing, and action gating.
// Port of Sources/KinesisCore/Gestures.swift with MacAction generalised to Action.

import type { CeremonyHTTPRequest } from "./ceremony";
import type { EMGConfiguration } from "./emg";

export type BandHand = "right" | "left";

export interface BandDevice {
  address: string;
  addressType: "public" | "random";
  name: string;
  rssi?: number;
}

export interface BandGesture {
  receivedAt: number;
  finger: string;
  action: string;
  derivedAction: string;
  synthetic: boolean;
  sequence: bigint;
  timestampUs: bigint;
}

export type BandEventPayload =
  | { type: "devices"; devices: BandDevice[] }
  | { type: "battery"; percent: number }
  /// In-band BatteryInfoResp; undefined when the band didn't answer or doesn't support it.
  | { type: "batteryStatus"; status: { level: number; charging: boolean | undefined } | undefined }
  | { type: "preparing" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "heartbeat" }
  /// One motion (gyro or orientation) frame, stamped with the band's own clock.
  | { type: "motion"; bandTimeUs: bigint }
  /// One gyro sample in raw counts (x, y, z).
  | { type: "gyro"; timestampUs: bigint; values: [number, number, number] }
  /// One orientation sample: a unit quaternion in wire order w, x, y, z.
  | { type: "orientation"; timestampUs: bigint; values: [number, number, number, number] }
  /// A reply or message from the band other than sensor data, for looking inside the protocol:
  /// device info, configuration, stream state, battery, and anything not otherwise understood.
  | { type: "inspection"; channel: number; kind: number; payload: Uint8Array }
  /// The band confirmed (or refused, or never answered) a change of motion streams.
  | { type: "motionStreams"; streams: MotionStreams; confirmedAfter: number; accepted: boolean }
  /// The band acknowledged the sensor subscription (data may still be on its way).
  | { type: "subscribed" }
  /// The desktop is showing a Bluetooth pairing prompt the person has to accept.
  | { type: "systemPairingPending" }
  /// Raw sEMG: the band's configuration, an accepted on/off change, a refused one, and each batch.
  | { type: "rawEMGConfiguration"; config: EMGConfiguration }
  | { type: "rawEMGState"; enabled: boolean }
  | { type: "rawEMGFailure"; message: string }
  | { type: "rawEMGFrame"; payload: Uint8Array }
  | { type: "gesture"; gesture: BandGesture }
  | { type: "dialState"; engaged: boolean }
  | { type: "dialTurn"; rotation: number }
  | { type: "handedness"; hand: BandHand }
  | { type: "handednessFailure"; message: string }
  | { type: "ceremonyStage"; message: string }
  | { type: "ceremonyHTTP"; request: CeremonyHTTPRequest };

/// Which motion streams the band sends besides gestures. Gyro (6) and orientation (8) stream at
/// 128 Hz each, most of the link's load, so each can be switched while connected.
export interface MotionStreams {
  gyro: boolean;
  orientation: boolean;
}

export const ALL_MOTION: MotionStreams = { gyro: true, orientation: true };

export function sameMotion(a: MotionStreams, b: MotionStreams): boolean {
  return a.gyro === b.gyro && a.orientation === b.orientation;
}

export interface BandEvent {
  payload: BandEventPayload;
  receivedAt: number;
}

export function gestureLabel(gesture: BandGesture): string | undefined {
  if (gesture.synthetic) return undefined;
  const names: Record<string, string> = {
    singleTap: "tap", doubleTap: "double tap", buttonHold: "hold",
    buttonPress: "pinch", buttonRelease: "release", buttonHoldRelease: "release",
    buttonUp: "swipe up", buttonDown: "swipe down", buttonLeft: "swipe left", buttonRight: "swipe right",
    tap: "tap", doubletap: "double tap", press: "pinch", release: "release",
    up: "swipe up", down: "swipe down", left: "swipe left", right: "swipe right",
  };
  const label = names[gesture.derivedAction] ?? names[gesture.action];
  if (!label) return undefined;
  return `${gesture.finger.charAt(0).toUpperCase()}${gesture.finger.slice(1)} ${label}`;
}

export const SWIPE_DIRECTIONS = ["left", "right", "up", "down"] as const;
export type SwipeDirection = (typeof SWIPE_DIRECTIONS)[number];

// An index hold is the pinch dial, so only the middle finger has a hold of its own.
export const TAP_GESTURES = ["indexTap", "indexDoubleTap", "middleTap", "middleDoubleTap", "middleHold"] as const;
export type TapGesture = (typeof TAP_GESTURES)[number];

export function tapFinger(tap: TapGesture): "index" | "middle" {
  return tap === "indexTap" || tap === "indexDoubleTap" ? "index" : "middle";
}
export function tapAction(tap: TapGesture): "tap" | "doubletap" | "hold" {
  if (tap === "middleHold") return "hold";
  return tap === "indexTap" || tap === "middleTap" ? "tap" : "doubletap";
}

export type RecognizedGesture = { kind: "swipe"; direction: SwipeDirection } | { kind: "tap"; tap: TapGesture };

export function recognizedKey(gesture: RecognizedGesture): string {
  return gesture.kind === "swipe" ? `swipe:${gesture.direction}` : `tap:${gesture.tap}`;
}

export function recognizedLabel(gesture: RecognizedGesture): string {
  if (gesture.kind === "swipe") return `Swipe ${gesture.direction}`;
  const finger = tapFinger(gesture.tap);
  const motion = { tap: "tap", doubletap: "double tap", hold: "hold" }[tapAction(gesture.tap)];
  return `${finger.charAt(0).toUpperCase()}${finger.slice(1)} ${motion}`;
}

export class GestureRouter {
  private seen: string[] = [];
  private last = new Map<string, { source: string; time: number }>();

  reset(): void {
    this.seen = [];
    this.last.clear();
  }

  gesture(message: BandGesture, now: number): RecognizedGesture | undefined {
    if (message.synthetic) return undefined;
    if (now - message.receivedAt < -0.1 || now - message.receivedAt > 0.35) return undefined;
    const derived: Record<string, SwipeDirection> = { buttonLeft: "left", buttonRight: "right", buttonUp: "up", buttonDown: "down" };
    let gesture: RecognizedGesture;
    let source: string;
    const rawDirection = (SWIPE_DIRECTIONS as readonly string[]).includes(message.action) ? (message.action as SwipeDirection) : undefined;
    const direction: SwipeDirection | undefined = derived[message.derivedAction] ?? rawDirection;
    if (message.finger === "thumb" && direction) {
      gesture = { kind: "swipe", direction };
      source = derived[message.derivedAction] === undefined ? "raw" : "derived";
    } else {
      const actions: Record<string, string> = { singleTap: "tap", doubleTap: "doubletap", buttonHold: "hold" };
      const action = actions[message.derivedAction] ?? message.action;
      const tap = TAP_GESTURES.find((t) => tapFinger(t) === message.finger && tapAction(t) === action);
      if (!tap) return undefined;
      gesture = { kind: "tap", tap };
      source = actions[message.derivedAction] === undefined ? "raw" : "derived";
    }
    const identity = `${message.sequence}:${message.timestampUs}:${message.finger}:${message.action}:${message.derivedAction}`;
    if (this.seen.includes(identity)) return undefined;
    this.seen.push(identity);
    if (this.seen.length > 128) this.seen.shift();
    const key = recognizedKey(gesture);
    const last = this.last.get(key);
    if (last && last.source !== source && Math.abs(message.receivedAt - last.time) < 0.18) return undefined;
    this.last.set(key, { source, time: message.receivedAt });
    return gesture;
  }
}

export const DIAL_TARGETS = ["none", "volume", "brightness"] as const;
export type DialTarget = (typeof DIAL_TARGETS)[number];

export function dialAction(target: DialTarget, increasing: boolean): Action {
  switch (target) {
    case "none": return "none";
    case "volume": return increasing ? "volumeUp" : "volumeDown";
    case "brightness": return increasing ? "brightnessUp" : "brightnessDown";
  }
}

export class DialRouter {
  private remainder = 0;
  private lastDispatch = -Infinity;
  private lastInput = -Infinity;

  reset(): void {
    this.remainder = 0;
    this.lastDispatch = -Infinity;
    this.lastInput = -Infinity;
  }

  turn(delta: number, sensitivity: number, now: number): number {
    if (!Number.isFinite(delta) || !Number.isFinite(sensitivity) || !Number.isFinite(now)) return 0;
    if (sensitivity < 0.5 || sensitivity > 4) return 0;
    if (now - this.lastInput > 0.35) this.reset();
    this.lastInput = now;
    if (this.remainder * delta < 0) this.remainder = 0;
    // One media-key step per two degrees in the relative gyro estimate at 1x.
    // Limit output to one step and discard excess whole steps after a fast flick.
    this.remainder = Math.min(2, Math.max(-2, this.remainder + delta * sensitivity * 0.5));
    if (now - this.lastDispatch < 0.08) return 0;
    const steps = Math.min(1, Math.max(-1, Math.trunc(this.remainder)));
    if (steps === 0) return 0;
    this.remainder = this.remainder % 1;
    this.lastDispatch = now;
    return steps;
  }
}

export const ACTIONS = [
  "none", "previousDesktop", "nextDesktop", "overview", "dismiss", "previousWindow", "nextWindow",
  "previousTab", "nextTab", "playPause", "nextTrack", "previousTrack", "mute", "volumeUp", "volumeDown",
  "brightnessUp", "brightnessDown", "launcher", "showDesktop",
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_TITLES: Record<Action, string> = {
  none: "No action",
  previousDesktop: "Previous desktop",
  nextDesktop: "Next desktop",
  overview: "Overview",
  dismiss: "Dismiss (Escape)",
  previousWindow: "Previous window",
  nextWindow: "Next window",
  previousTab: "Previous tab",
  nextTab: "Next tab",
  playPause: "Play / pause",
  nextTrack: "Next track",
  previousTrack: "Previous track",
  mute: "Mute / unmute",
  volumeUp: "Volume up",
  volumeDown: "Volume down",
  brightnessUp: "Brightness up",
  brightnessDown: "Brightness down",
  launcher: "Application launcher",
  showDesktop: "Show desktop",
};

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export class ActionGate {
  private armedAt = Infinity;
  private lastAction = -Infinity;

  constructor(private readonly minimumInterval = 0.4) {}

  arm(time: number): void {
    this.armedAt = time;
    this.lastAction = -Infinity;
  }

  pause(): void {
    this.armedAt = Infinity;
  }

  allows(eventTime: number, now: number, live: boolean, trusted: boolean): boolean {
    if (!live || !trusted || eventTime < this.armedAt) return false;
    if (now - eventTime > 0.35 || now - eventTime < -0.1) return false;
    if (now - this.lastAction < this.minimumInterval) return false;
    this.lastAction = now;
    return true;
  }
}
