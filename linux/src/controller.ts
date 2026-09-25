// Headless port of Sources/Kinesis/BandModel.swift: turns band events into desktop
// actions with the same gating, de-duplication, dial, and reconnect rules as the Mac app.

import type { ActionBackend } from "./actions";
import { AirPointer, type ForearmAim, PointerHome, PointerPacer, PointerReach, type Vec2, forearmAim, forearmAxis } from "./air-cursor";
import type { Config } from "./config";
import { type BandOperation, type Logger, now } from "./connection";
import type { EMGConfiguration } from "./emg";
import type { BandEnrollmentIdentity } from "./identity";
import {
  ACTION_TITLES, type Action, ActionGate, type BandDevice, type BandEvent, type BandHand, DialRouter, GestureRouter,
  type BandGesture, type MotionStreams, type RecognizedGesture, type SwipeDirection, dialAction, gestureLabel, recognizedLabel,
  sameMotion,
} from "./gestures";
import { KeyWatcher } from "./keys";
import { type MouseButton, type PointerDevice, UinputPointer } from "./uinput";

export interface ConnectionLike {
  readonly active: boolean;
  start(operation: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void>;
  stop(): void;
  setHandedness(hand: BandHand): void;
  setRawEMG(enabled: boolean): void;
  /// Which motion streams to keep on, now and for later sessions.
  setMotionStreams(streams: MotionStreams): void;
  /// Turn the motion streams off and on again, to clear a backed-up stream.
  restartMotionStreams(): void;
}

/// Pointer actions tried since the cursor page opened, so it can show them done.
export type CursorSkill = "click" | "rightClick" | "doubleClick" | "drag";

/// The air cursor (developer mode): move the pointer with the forearm, pinch to click.
export interface AirCursorState {
  enabled: boolean;
  /// Developer mode is on, the band is live, controls are on, and its hand is confirmed.
  available: boolean;
  /// Alt is held: the arm moves without moving the pointer.
  repositioning: boolean;
  /// Escape and Alt are being watched (a keyboard was readable).
  keys: boolean;
  skills: CursorSkill[];
  error: string | undefined;
}

/// One motion sample, for readings and the cursor page.
export type MotionSample =
  | { kind: "gyro"; receivedAt: number; delay: number; degreesPerSecond: [number, number, number]; armSpeed: number }
  | { kind: "orientation"; receivedAt: number; delay: number; aim: ForearmAim };

export interface KeyWatching {
  start(): number;
  stop(): void;
}

/// How the air cursor reaches the desktop, swappable in tests.
export interface CursorOptions {
  openPointer?: (log: Logger) => PointerDevice;
  watchKeys?: (hooks: { onEscape(): void; onAlt(held: boolean): void }) => KeyWatching;
  /// "timer" moves the pointer every few milliseconds; "manual" waits for cursorFrame() (tests).
  frames?: "timer" | "manual";
}

/// Two presses this close in time and space are a double-click, as with a trackpad.
const DOUBLE_CLICK_TIME = 0.45;
const DOUBLE_CLICK_DISTANCE = 6;
/// The virtual mouse is kept this long after the cursor turns off, so turning it on again is instant.
const POINTER_IDLE_SECONDS = 300;

/// Raw sEMG readings (developer mode): what's wanted, what the band confirmed, and its layout.
export interface ReadingsState {
  wanted: boolean;
  active: boolean;
  /// A change is on its way to the band (or will be applied when it connects).
  pending: boolean;
  error: string | undefined;
  config: EMGConfiguration | undefined;
}

/// Machine-readable connection status; `phase` is the matching human text.
export type ControllerStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "asleep";

/// The outcome of one dispatched action (a dial turn may send it several times).
export interface ActionResult {
  action: Action;
  title: string;
  count: number;
  ok: boolean;
  error?: string;
}

/// How late band data arrives, against the band's own clock: the smallest host-minus-band offset
/// seen (drifting up slowly) is the on-time baseline. Port of AirCursor.swift's ArrivalDelay.
export class ArrivalDelay {
  private baseline: number | undefined;
  private lastBand: number | undefined;
  private lastHost: number | undefined;

  measure(band: number, host: number): number {
    if (!Number.isFinite(band) || !Number.isFinite(host)) return 0;
    // The band's clock restarted, so the old baseline no longer applies.
    if (this.lastBand !== undefined && band < this.lastBand - 1) this.reset();
    const offset = host - band;
    this.baseline = this.baseline !== undefined && this.lastHost !== undefined
      ? Math.min(this.baseline + Math.max(0, host - this.lastHost) * 0.0005, offset)
      : offset;
    this.lastBand = band;
    this.lastHost = host;
    return Math.max(0, offset - this.baseline);
  }

  reset(): void {
    this.baseline = undefined;
    this.lastBand = undefined;
    this.lastHost = undefined;
  }
}

/// Motion arriving later than this means the radio link is falling behind.
export const LATE_INPUT = 0.3;

export interface ControllerState {
  phase: string;
  status: ControllerStatus;
  live: boolean;
  controlsEnabled: boolean;
  battery: number | undefined;
  /// From the in-band battery status; undefined when the band doesn't say.
  charging: boolean | undefined;
  bandHand: BandHand;
  handConfirmed: boolean;
  pendingHand: BandHand | undefined;
  handSettingError: string | undefined;
  lastGesture: string;
  lastAction: string;
  gestureCount: number;
  dialEngaged: boolean;
  pinchedFinger: string | undefined;
  error: string | undefined;
  /// The link is up but sensor frames aren't flowing (off the wrist, or on the charger?).
  streamHint: string | undefined;
  /// Band data has been arriving late for a while: the radio link is congested.
  linkCongested: boolean;
  /// The desktop is showing a Bluetooth pairing request to accept.
  awaitingSystemPairing: boolean;
  readings: ReadingsState;
  airCursor: AirCursorState;
  /// The motion streams asked of the band.
  motionStreams: MotionStreams;
}

export interface ControllerHooks {
  onState?(state: ControllerState): void;
  onGesture?(gesture: RecognizedGesture): void;
  onDial?(delta: number): void;
  onAction?(result: ActionResult): void;
  /// One raw sEMG batch, as the band sent it.
  onRawEMG?(payload: Uint8Array, receivedAt: number): void;
  onHandConfirmed?(hand: BandHand): void;
  /// Every gyro and orientation sample, with its measured delay.
  onMotion?(sample: MotionSample): void;
  /// Every band event, before anything else sees it (the motion log).
  onBandEvent?(event: BandEvent): void;
  /// BlueZ resolved the band's current identity (address may differ from the one saved at scan time).
  onBandResolved?(device: BandDevice): void;
}

export class Controller {
  readonly state: ControllerState = {
    phase: "Disconnected", status: "disconnected", live: false, controlsEnabled: false, battery: undefined,
    charging: undefined, bandHand: "right",
    handConfirmed: false, pendingHand: undefined, handSettingError: undefined, lastGesture: "Waiting for a gesture",
    lastAction: "Controls are paused", gestureCount: 0, dialEngaged: false, pinchedFinger: undefined, error: undefined,
    streamHint: undefined, linkCongested: false, awaitingSystemPairing: false,
    readings: { wanted: false, active: false, pending: false, error: undefined, config: undefined },
    airCursor: { enabled: false, available: false, repositioning: false, keys: false, skills: [], error: undefined },
    motionStreams: { gyro: true, orientation: false },
  };
  private wantsConnection = false;
  private busy = false;
  private quitting = false;
  private sleeping = false;
  private router = new GestureRouter();
  private gate = new ActionGate();
  private dialGate = new ActionGate(0);
  private dialRouter = new DialRouter();
  private dialArmed = false;
  private lastDialAction = -Infinity;
  private heartbeat: number | undefined;
  private started = 0;
  private retries = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private band: BandDevice | undefined;
  private enableWhenLive = false;
  private enrollment: BandEnrollmentIdentity | undefined;
  // Sensor-stream health, as the Mac app tracks it: status replies prove the link is alive, not
  // that its sensors are flowing.
  private lastSensorAt: number | undefined;
  private sensorHealthySince: number | undefined;
  private subscribedAt: number | undefined;
  private sensorRecoveryUsed = false;
  private sensorRecoveryPending = false;
  private readonly arrival = new ArrivalDelay();
  private linkLateSince: number | undefined;
  private linkOnTimeSince: number | undefined;
  private linkDelay = 0;
  private linkDelayAt = -Infinity;
  private lastMotionRestart = -Infinity;
  // Air cursor (port of BandModel's cursor half).
  private readonly airPointer = new AirPointer();
  private readonly pacer = new PointerPacer(PointerPacer.playbackSeconds);
  private readonly home = new PointerHome();
  private reach = PointerReach.standard("right");
  private pointer: PointerDevice | undefined;
  private pointerIdle: ReturnType<typeof setTimeout> | undefined;
  private keys: KeyWatching | undefined;
  private cursorTimer: ReturnType<typeof setInterval> | undefined;
  private cursorNeedsAnchor = true;
  private cursorMotionResumesAt = -Infinity;
  private cursorLastOrientation = -Infinity;
  /// The mouse button a pinch is holding down, so moving drags and letting go releases.
  private heldButton: { button: MouseButton; finger: string } | undefined;
  private lastPress: { time: number; button: MouseButton; clicks: number; at: Vec2 } | undefined;
  private cursorPressedFingers = new Set<string>();
  private cursorArmedAt = Infinity;
  /// Everything this cursor has moved the pointer, in pixels: where it would be with no edges and
  /// no other mouse. The pointer's real position is Wayland's secret, so home follows this instead.
  private posted: Vec2 = [0, 0];
  private fraction: Vec2 = [0, 0];
  /// Who wants orientation besides the cursor: the readings page, the cursor page, the motion log.
  private motionViewers = { readings: false, cursor: false, log: false };
  private requestedMotion: MotionStreams | undefined;

  constructor(
    private config: Config,
    private readonly connection: ConnectionLike,
    private backend: ActionBackend,
    private readonly log: Logger,
    private readonly hooks: ControllerHooks = {},
    private readonly clock: () => number = now,
    private readonly cursor: CursorOptions = {},
  ) {
    this.state.bandHand = config.hand ?? "right";
    this.reach = PointerReach.standard(this.state.bandHand);
    this.applyCursorSettings();
    this.started = clock();
    this.updateMotionStreams();
  }

  private connectOperation(band: BandDevice): BandOperation {
    return {
      kind: "connect", band, security: this.config.security,
      session: {
        configChannel: this.config.configChannel, rawEMG: this.state.readings.wanted,
        ...(this.enrollment ? { enrollment: this.enrollment } : {}),
      },
      bond: this.config.bond, directL2cap: this.config.directL2cap, psm: this.config.psm,
    };
  }

  /// Connect and keep reconnecting until disconnect() is called. Pass the enrolled identity to
  /// prove band ownership each session (without it, an enrolled band closes the input service).
  connect(band: BandDevice, options: { enableControls: boolean; enrollment?: BandEnrollmentIdentity }): void {
    if (this.busy || this.sleeping) return;
    this.quitting = false;
    this.band = band;
    this.enrollment = options.enrollment;
    this.wantsConnection = true;
    this.enableWhenLive = options.enableControls;
    this.retries = 0;
    this.sensorRecoveryUsed = false;
    this.ticker ??= setInterval(() => this.tick(), 500);
    this.run(this.connectOperation(band));
  }

  /// Apply edited settings (mappings, dial) to the running session without reconnecting.
  updateConfig(config: Config, backend?: ActionBackend): void {
    this.config = config;
    if (backend) this.backend = backend;
    this.applyCursorSettings();
    if (!config.developerMode) {
      this.setAirCursorEnabled(false);
      this.closePointer();
    }
    this.changed();
  }

  private applyCursorSettings(): void {
    this.airPointer.steadiness = this.config.cursor.steadiness;
    this.airPointer.tuning.fastFactor = this.config.cursor.flickBoost;
  }

  /// Ask for raw sEMG on or off. Applied now if the band is live, otherwise on the next connect.
  setRawEMG(enabled: boolean): void {
    const readings = this.state.readings;
    readings.wanted = enabled;
    readings.error = undefined;
    if (this.state.live) {
      readings.pending = readings.active !== enabled;
      if (readings.pending) {
        try {
          this.connection.setRawEMG(enabled);
        } catch (error) {
          readings.pending = false;
          readings.error = error instanceof Error ? error.message : String(error);
        }
      }
    } else {
      readings.pending = false;
    }
    this.changed();
  }

  /// The computer is about to suspend: drop the link without reconnecting until wake().
  sleep(): void {
    if (this.sleeping) return;
    this.sleeping = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.state.live = false;
    this.suspendActions();
    this.setPhase("Computer is asleep", "asleep");
    if (this.busy) this.connection.stop();
  }

  /// Back from suspend: reconnect if a connection was wanted.
  wake(): void {
    if (!this.sleeping) return;
    this.sleeping = false;
    if (this.busy) return;
    if (this.wantsConnection && !this.quitting) this.scheduleReconnect();
    else this.setPhase("Disconnected", "disconnected");
  }

  get wantsToConnect(): boolean {
    return this.wantsConnection;
  }

  async disconnect(): Promise<void> {
    this.quitting = true;
    this.wantsConnection = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.pause();
    this.closePointer();
    this.state.live = false;
    this.state.handConfirmed = false;
    this.state.pendingHand = undefined;
    this.setPhase(this.busy ? "Disconnecting…" : "Disconnected", this.busy ? "disconnecting" : "disconnected");
    this.connection.stop();
    const deadline = Date.now() + 8000;
    while (this.busy && Date.now() < deadline) await Bun.sleep(100);
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  enableControls(): boolean {
    if (this.state.pendingHand !== undefined || !this.state.live) return false;
    this.enableWhenLive = false;
    this.gate.arm(this.clock());
    this.resetDial();
    this.state.controlsEnabled = true;
    this.state.error = undefined;
    this.state.lastAction = "Ready for your next gesture";
    this.changed();
    return true;
  }

  pause(): void {
    this.enableWhenLive = false;
    this.suspendActions();
    this.state.controlsEnabled = false;
    this.state.lastAction = "Controls are paused";
    this.changed();
  }

  get canUseAirCursor(): boolean {
    return this.config.developerMode && this.state.live && this.state.controlsEnabled && this.state.handConfirmed
      && this.state.pendingHand === undefined;
  }

  /// Turn the air cursor on or off. False when it can't come on; `airCursor.error` says why.
  setAirCursorEnabled(enabled: boolean): boolean {
    const cursor = this.state.airCursor;
    if (!enabled) this.releaseHeldButton();
    if (enabled && !this.canUseAirCursor) return false;
    if (enabled === cursor.enabled) return true;
    if (enabled) {
      try {
        this.openPointer();
      } catch (error) {
        cursor.error = error instanceof Error ? error.message : String(error);
        this.changed();
        return false;
      }
    }
    cursor.enabled = enabled;
    cursor.repositioning = false;
    cursor.error = undefined;
    // Start from wherever the pointer is.
    this.cursorNeedsAnchor = true;
    this.cursorMotionResumesAt = -Infinity;
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    this.cursorTimer = undefined;
    this.pacer.clear();
    this.home.reset();
    this.posted = [0, 0];
    this.fraction = [0, 0];
    this.keys?.stop();
    this.keys = undefined;
    cursor.keys = false;
    if (enabled) {
      // The orientation arrives at 128 Hz; the pointer moves every 4 ms, faster than any display.
      if ((this.cursor.frames ?? "timer") === "timer") this.cursorTimer = setInterval(() => this.cursorFrame(), 4);
      const watchKeys = this.cursor.watchKeys ?? ((hooks) => new KeyWatcher(hooks));
      this.keys = watchKeys({
        onEscape: () => this.setAirCursorEnabled(false),
        onAlt: (held) => this.setCursorRepositioning(held),
      });
      cursor.keys = this.keys.start() > 0;
    } else {
      this.schedulePointerClose();
    }
    this.cursorPressedFingers = new Set(this.state.pinchedFinger ? [this.state.pinchedFinger] : []);
    this.cursorArmedAt = enabled ? this.clock() : Infinity;
    this.router.reset();
    this.resetDial();
    this.state.dialEngaged = false;
    if (this.state.controlsEnabled) this.gate.arm(this.clock());
    this.state.lastAction = enabled ? `Air cursor on${cursor.keys ? " · Escape to stop" : ""}` : "Air cursor off";
    this.updateMotionStreams();
    this.changed();
    return true;
  }

  /// Alt is held (or let go): like lifting a mouse, the arm moves without moving the pointer.
  setCursorRepositioning(repositioning: boolean): void {
    const active = this.state.airCursor.enabled && repositioning;
    if (active === this.state.airCursor.repositioning) return;
    this.state.airCursor.repositioning = active;
    // The arm was set down somewhere new: that is home now.
    if (!active) this.home.reset();
    // Pinches are ignored while Alt is down, so a drag could never be let go. End it now.
    if (active) this.releaseHeldButton();
    this.cursorPressedFingers.clear();
    this.state.pinchedFinger = undefined;
    this.steadyCursor(this.clock() + 0.12);
    this.changed();
  }

  /// Who else wants the orientation stream: the readings page, the cursor page, the motion log.
  /// The cursor page also prepares the virtual mouse, which Plasma takes a moment to adopt.
  setMotionViewers(viewers: { readings: boolean; cursor: boolean; log: boolean }): void {
    const opened = viewers.cursor && !this.motionViewers.cursor;
    this.motionViewers = { ...viewers };
    if (opened) this.state.airCursor.skills = [];
    if (viewers.cursor && this.config.developerMode && !this.pointer) {
      try {
        this.openPointer();
        this.state.airCursor.error = undefined;
      } catch (error) {
        this.state.airCursor.error = error instanceof Error ? error.message : String(error);
      }
    }
    if (!viewers.cursor && !this.state.airCursor.enabled) this.schedulePointerClose();
    this.updateMotionStreams();
    this.changed();
  }

  /// Closes the virtual mouse (the daemon is stopping, or developer mode went off).
  closePointer(): void {
    this.releaseHeldButton();
    if (this.pointerIdle) clearTimeout(this.pointerIdle);
    this.pointerIdle = undefined;
    this.pointer?.close();
    this.pointer = undefined;
  }

  private openPointer(): PointerDevice {
    if (this.pointerIdle) clearTimeout(this.pointerIdle);
    this.pointerIdle = undefined;
    this.pointer ??= (this.cursor.openPointer ?? ((log) => UinputPointer.open(log)))(this.log);
    return this.pointer;
  }

  private schedulePointerClose(): void {
    if (!this.pointer || this.pointerIdle || this.state.airCursor.enabled || this.motionViewers.cursor) return;
    this.pointerIdle = setTimeout(() => {
      this.pointerIdle = undefined;
      if (!this.state.airCursor.enabled && !this.motionViewers.cursor) this.closePointer();
    }, POINTER_IDLE_SECONDS * 1000);
  }

  /// Orientation is half the link's load, and only the air cursor and the motion views use it.
  /// The gyro stays on for the dial.
  private updateMotionStreams(): void {
    const viewers = this.motionViewers;
    const wanted: MotionStreams = {
      gyro: true,
      orientation: this.state.airCursor.enabled || viewers.readings || viewers.cursor || viewers.log,
    };
    this.state.motionStreams = wanted;
    if (this.requestedMotion && sameMotion(this.requestedMotion, wanted)) return;
    this.requestedMotion = wanted;
    this.connection.setMotionStreams(wanted);
  }

  /// One frame of pointer movement: this frame's share of what the arm moved.
  cursorFrame(): void {
    const now = this.clock();
    const cursor = this.state.airCursor;
    if (!cursor.enabled || !this.canUseAirCursor || now - this.cursorLastOrientation > 0.15) {
      this.pacer.clear();
      return;
    }
    const movement = this.airPointer.timedMovement();
    if (!movement) return;
    // Alt, a pinch, or the first frame drops what moved meanwhile, like lifting a mouse. The first
    // frame after a hold drops the settling that came with it.
    if (cursor.repositioning || now < this.cursorMotionResumesAt || this.cursorNeedsAnchor) {
      if (!cursor.repositioning && now >= this.cursorMotionResumesAt) this.cursorNeedsAnchor = false;
      this.pacer.clear();
      return;
    }
    // Stillness and acceleration are already in the movement, sample by sample.
    const scale = this.config.cursor.speed;
    const pointer: Vec2 = [this.posted[0] / scale, this.posted[1] / scale];
    const aim = this.airPointer.aim;
    const arm = aim ? this.reach.screenDegrees([aim.azimuth, aim.elevation]) : undefined;
    for (const step of movement) {
      let degrees = this.reach.screenDegrees(step.step);
      if (arm) degrees = this.home.adjust(degrees, pointer, arm, this.airPointer.tuning.recentering);
      this.pacer.add([degrees[0] * scale, degrees[1] * scale], step.time);
    }
    const delta = this.pacer.take(now);
    if (!delta) return;
    this.posted = [this.posted[0] + delta[0], this.posted[1] + delta[1]];
    // Whole pixels, carrying the fraction to the next frame.
    const x = this.fraction[0] + delta[0], y = this.fraction[1] + delta[1];
    const dx = Math.round(x), dy = Math.round(y);
    this.fraction = [x - dx, y - dy];
    if (this.heldButton) this.learned("drag");
    try {
      this.pointer?.move(dx, dy);
    } catch (error) {
      this.cursorFailed(error);
    }
  }

  private cursorFailed(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.heldButton = undefined;
    this.closePointer();
    this.pause();
  }

  private receiveCursorGesture(message: BandGesture, time: number): void {
    if (!this.canUseAirCursor || message.synthetic || !["index", "middle"].includes(message.finger)
      || message.receivedAt < this.cursorArmedAt || time - message.receivedAt > 0.1) return;
    const actions = [message.action, message.derivedAction];
    if (actions.some((a) => ["release", "buttonRelease", "buttonHoldRelease"].includes(a))) {
      if (this.cursorPressedFingers.delete(message.finger)) {
        if (this.airPointer.approach !== "tracking") this.guardCursorClick(message.receivedAt - this.linkDelay);
        if (this.heldButton?.finger === message.finger) this.releaseHeldButton();
      }
      if (this.state.pinchedFinger === message.finger) this.state.pinchedFinger = undefined;
      this.changed();
      return;
    }
    // One complete click at pinch onset. Ignore its hold, tap and double-tap reports, which
    // describe the same contact and would otherwise click again.
    if (!actions.some((a) => a === "press" || a === "buttonPress") || actions.includes("buttonHold")
      || this.cursorPressedFingers.has(message.finger)) return;
    this.cursorPressedFingers.add(message.finger);
    // Held still or settling onto a target: absorb the drift that follows the pinch. Tracking
    // something that moves: hold nothing back.
    if (this.airPointer.approach !== "tracking") this.guardCursorClick(message.receivedAt - this.linkDelay);
    this.state.pinchedFinger = message.finger;
    const button: MouseButton = message.finger === "index" ? "left" : "right";
    // One button at a time, like a trackpad.
    if (this.heldButton) this.releaseHeldButton();
    // The press lands where the pointer is, so the pointer never jumps. The desktop counts the
    // double-click itself; this only notices one for the cursor page.
    const last = this.lastPress;
    let clicks = 1;
    if (last && last.button === button && time - last.time <= DOUBLE_CLICK_TIME
      && Math.hypot(this.posted[0] - last.at[0], this.posted[1] - last.at[1]) <= DOUBLE_CLICK_DISTANCE) {
      clicks = Math.min(3, last.clicks + 1);
    }
    try {
      this.openPointer().button(button, true);
    } catch (error) {
      this.cursorFailed(error);
      return;
    }
    this.heldButton = { button, finger: message.finger };
    this.learned(button === "right" ? "rightClick" : clicks > 1 ? "doubleClick" : "click");
    this.lastPress = { time, button, clicks, at: [...this.posted] };
    this.state.lastAction = button === "left" ? (clicks > 1 ? "Double click" : "Left click") : "Right click";
    this.state.gestureCount += 1;
    this.hooks.onGesture?.({ kind: "tap", tap: message.finger === "index" ? "indexTap" : "middleTap" });
    this.changed();
  }

  /// Absorbs the drift after a pinch or a release: movement still waiting is dropped with it, as
  /// it would carry the pointer on past the click.
  private guardCursorClick(time: number): void {
    this.airPointer.guardClick(time);
    this.pacer.clear();
  }

  /// Lets go of a button a pinch holds. Never leaves one stuck down: this runs when the pinch ends,
  /// when the cursor turns off, and when the link falls behind.
  private releaseHeldButton(): void {
    const held = this.heldButton;
    if (!held) return;
    this.heldButton = undefined;
    try {
      this.pointer?.button(held.button, false);
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    }
  }

  /// Hold the pointer still through a pinch, and drop what the pinch's twitch moved.
  private steadyCursor(until: number): void {
    this.cursorMotionResumesAt = Math.max(this.cursorMotionResumesAt, until);
    this.cursorNeedsAnchor = true;
  }

  private learned(skill: CursorSkill): void {
    const skills = this.state.airCursor.skills;
    if (this.motionViewers.cursor && !skills.includes(skill)) {
      skills.push(skill);
      this.changed();
    }
  }

  get canChangeHand(): boolean {
    return this.state.live && this.state.handConfirmed && this.state.pendingHand === undefined;
  }

  selectHand(hand: BandHand): void {
    if (!this.canChangeHand || hand === this.state.bandHand) return;
    this.pause();
    this.router.reset();
    this.state.lastGesture = "Waiting for a gesture";
    this.state.pendingHand = hand;
    this.state.handSettingError = undefined;
    try {
      this.connection.setHandedness(hand);
    } catch (error) {
      this.state.pendingHand = undefined;
      this.state.handConfirmed = false;
      this.state.handSettingError = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  private setPhase(phase: string, status: ControllerStatus): void {
    if (this.state.phase !== phase || this.state.status !== status) {
      this.state.phase = phase;
      this.state.status = status;
      this.changed();
    }
  }

  private changed(): void {
    this.state.airCursor.available = this.canUseAirCursor;
    this.hooks.onState?.(this.state);
  }

  private resetDial(): void {
    this.dialArmed = false;
    this.dialGate.pause();
    this.dialRouter.reset();
  }

  private suspendActions(): void {
    this.setAirCursorEnabled(false);
    this.gate.pause();
    this.resetDial();
    this.state.dialEngaged = false;
    this.state.pinchedFinger = undefined;
  }

  private run(operation: BandOperation): void {
    if (this.busy) return;
    this.busy = true;
    this.state.error = undefined;
    this.setPhase("Preparing…", "connecting");
    this.state.live = false;
    this.heartbeat = undefined;
    this.state.handConfirmed = false;
    this.state.pendingHand = undefined;
    this.state.handSettingError = undefined;
    this.started = this.clock();
    this.router.reset();
    this.suspendActions();
    this.lastSensorAt = undefined;
    this.sensorHealthySince = undefined;
    this.subscribedAt = undefined;
    this.sensorRecoveryPending = false;
    this.arrival.reset();
    this.linkLateSince = undefined;
    this.linkOnTimeSince = undefined;
    this.linkDelay = 0;
    this.linkDelayAt = -Infinity;
    this.airPointer.discard();
    this.cursorNeedsAnchor = true;
    this.state.streamHint = undefined;
    this.state.linkCongested = false;
    this.state.awaitingSystemPairing = false;
    // A new session starts with EMG off; the session turns it back on after subscribing if wanted.
    this.state.readings = { ...this.state.readings, active: false, pending: this.state.readings.wanted, config: undefined };
    this.connection.start(operation, (event) => this.receive(event), (error) => this.connectionEnded(error))
      .catch((error: unknown) => this.connectionEnded(error instanceof Error ? error : new Error(String(error))));
  }

  private connectionEnded(failure: Error | undefined): void {
    if (failure && !this.quitting && this.state.error === undefined && this.wantsConnection) {
      this.state.error = failure.message;
    }
    this.busy = false;
    this.state.live = false;
    this.state.handConfirmed = false;
    this.state.pendingHand = undefined;
    this.suspendActions();
    if (this.sleeping) this.setPhase("Computer is asleep", "asleep");
    else if (this.wantsConnection && !this.quitting) this.scheduleReconnect();
    else this.setPhase("Disconnected", "disconnected");
    this.changed();
  }

  private receive(event: BandEvent): void {
    this.hooks.onBandEvent?.(event);
    const time = this.clock();
    const payload = event.payload;
    switch (payload.type) {
      case "devices":
        if (payload.devices.length === 1) this.hooks.onBandResolved?.(payload.devices[0]!);
        break;
      case "battery":
        this.state.battery = payload.percent;
        this.changed();
        break;
      case "batteryStatus":
        if (payload.status) {
          this.state.battery = payload.status.level;
          this.state.charging = payload.status.charging;
          this.changed();
        }
        break;
      case "handedness":
        if (!this.wantsConnection) return;
        this.state.bandHand = payload.hand;
        this.reach = PointerReach.standard(payload.hand);
        this.state.handConfirmed = true;
        this.state.pendingHand = undefined;
        this.state.handSettingError = undefined;
        this.hooks.onHandConfirmed?.(payload.hand);
        this.changed();
        break;
      case "handednessFailure":
        this.setAirCursorEnabled(false);
        this.state.handConfirmed = false;
        this.state.pendingHand = undefined;
        this.state.handSettingError = payload.message;
        this.changed();
        break;
      case "preparing":
        this.setPhase("Preparing…", "connecting");
        break;
      case "motion":
        this.markDataArrived(event.receivedAt);
        break;
      case "gyro": {
        const delay = this.measureLinkDelay(payload.timestampUs, event.receivedAt);
        if (delay <= LATE_INPUT) this.airPointer.receiveGyro(payload.values, event.receivedAt - delay);
        const [x, y, z] = payload.values;
        this.hooks.onMotion?.({
          kind: "gyro", receivedAt: event.receivedAt, delay, armSpeed: this.airPointer.speed,
          degreesPerSecond: [x * AirPointer.gyroScale, y * AirPointer.gyroScale, z * AirPointer.gyroScale],
        });
        break;
      }
      case "orientation": {
        const aim = forearmAim(payload.values, forearmAxis(this.state.bandHand));
        if (!aim) break;
        const delay = this.measureLinkDelay(payload.timestampUs, event.receivedAt);
        this.hooks.onMotion?.({ kind: "orientation", receivedAt: event.receivedAt, delay, aim });
        // A late sample is where the arm was, not where it is. Skipping it pauses the pointer, and
        // the gap re-anchors it when fresh data returns.
        if (delay > LATE_INPUT) break;
        // The band's own clock says when it sampled: two samples share each radio batch.
        if (!this.airPointer.receive(aim, event.receivedAt - delay)) this.cursorNeedsAnchor = true;
        this.cursorLastOrientation = event.receivedAt;
        break;
      }
      case "subscribed":
        this.subscribedAt = time;
        break;
      case "systemPairingPending":
        this.state.awaitingSystemPairing = true;
        this.changed();
        break;
      case "rawEMGConfiguration":
        this.state.readings.config = payload.config;
        this.changed();
        break;
      case "rawEMGState":
        this.state.readings.active = payload.enabled;
        this.state.readings.pending = this.state.readings.wanted !== payload.enabled;
        this.changed();
        // The wish changed while this change was in flight: send the newer one.
        if (this.state.readings.pending && this.state.live) this.setRawEMG(this.state.readings.wanted);
        break;
      case "rawEMGFailure":
        this.state.readings.pending = false;
        this.state.readings.error = payload.message;
        this.changed();
        break;
      case "rawEMGFrame":
        this.markDataArrived(event.receivedAt);
        this.hooks.onRawEMG?.(payload.payload, event.receivedAt);
        break;
      case "connected":
        this.state.awaitingSystemPairing = false;
        this.setPhase("Connected", "connected");
        this.retries = 0;
        this.state.error = undefined;
        if (this.state.controlsEnabled) this.gate.arm(time);
        break;
      case "disconnected":
        this.state.live = false;
        this.suspendActions();
        this.changed();
        break;
      case "heartbeat":
        if (Math.abs(time - event.receivedAt) < 0.6) this.receivedInput();
        break;
      case "gesture": {
        const message = payload.gesture;
        if (!this.wantsConnection || time - message.receivedAt > 0.35 || time - message.receivedAt < -0.1) return;
        this.receivedInput();
        if (this.state.pendingHand !== undefined) return;
        // Gestures share one pipe with motion, so they are exactly as late as the motion around
        // them. A pinch from seconds ago must not click now.
        if (this.linkIsLate(time)) {
          if (this.heldButton?.finger === message.finger) this.releaseHeldButton();
          // Forget this finger's pinch too: a dropped release would otherwise swallow the next press.
          this.cursorPressedFingers.delete(message.finger);
          if (this.state.pinchedFinger === message.finger) this.state.pinchedFinger = undefined;
          this.log.notice(`Dropped a ${message.finger} ${message.action} that arrived ${this.linkDelay.toFixed(2)}s late`);
          return;
        }
        const label = gestureLabel(message);
        if (label && this.state.lastGesture !== label) this.state.lastGesture = label;
        if (this.state.airCursor.enabled) {
          if (this.state.airCursor.repositioning) return;
          if (message.finger !== "thumb") {
            this.receiveCursorGesture(message, time);
            return;
          }
        }
        if (!message.synthetic && ["index", "middle"].includes(message.finger)) {
          const actions = [message.derivedAction, message.action];
          if (actions.some((a) => ["press", "hold", "buttonPress", "buttonHold"].includes(a)) && this.state.pinchedFinger !== message.finger) {
            this.state.pinchedFinger = message.finger;
          } else if (actions.some((a) => ["release", "buttonRelease", "buttonHoldRelease"].includes(a)) && this.state.pinchedFinger === message.finger) {
            this.state.pinchedFinger = undefined;
          }
        }
        const gesture = this.router.gesture(message, time);
        if (!gesture) return;
        if (this.state.airCursor.enabled) this.steadyCursor(time + 0.12);
        let action: Action;
        if (gesture.kind === "swipe") {
          action = this.config.swipes[gesture.direction as SwipeDirection];
        } else {
          // Releasing a wrist turn must not also trigger an index-tap assignment.
          if (gesture.tap.startsWith("index") && time - this.lastDialAction <= 0.6) return;
          action = this.config.taps[gesture.tap];
        }
        this.state.lastGesture = recognizedLabel(gesture);
        this.state.gestureCount += 1;
        this.hooks.onGesture?.(gesture);
        if (!this.state.controlsEnabled || action === "none") { this.changed(); return; }
        if (!this.gate.allows(message.receivedAt, time, this.state.live, this.backend.supports(action))) { this.changed(); return; }
        void this.dispatch(action);
        break;
      }
      case "dialState":
        if (this.state.airCursor.enabled) return;
        if (!this.state.live || this.state.pendingHand !== undefined || Math.abs(time - event.receivedAt) > 0.35
          || this.linkIsLate(time)) { this.resetDial(); return; }
        this.state.dialEngaged = payload.engaged;
        this.resetDial();
        if (payload.engaged && this.state.controlsEnabled) {
          this.dialArmed = true;
          this.dialGate.arm(event.receivedAt);
        }
        this.changed();
        break;
      case "dialTurn": {
        if (this.state.airCursor.enabled) return;
        if (!this.state.live || !this.state.handConfirmed || !this.state.dialEngaged) return;
        if (Math.abs(time - event.receivedAt) > 0.35 || !Number.isFinite(payload.rotation)) return;
        if (this.linkIsLate(time)) {
          this.resetDial();
          this.state.dialEngaged = false;
          return;
        }
        // The same intended turn produced the opposite gyro sign on the left wrist.
        const delta = this.state.bandHand === "left" ? -payload.rotation : payload.rotation;
        this.hooks.onDial?.(delta);
        const target = this.config.dial.target;
        if (!this.state.controlsEnabled || !this.dialArmed || target === "none") return;
        const action = dialAction(target, delta > 0);
        if (!this.dialGate.allows(event.receivedAt, time, this.state.live, this.backend.supports(action))) return;
        const steps = this.dialRouter.turn(delta, this.config.dial.sensitivity, time);
        if (steps === 0) return;
        this.lastDialAction = time;
        this.state.lastGesture = steps > 0 ? "Wrist turn +" : "Wrist turn −";
        void this.dispatch(dialAction(target, steps > 0), Math.abs(steps));
        break;
      }
    }
  }

  private receivedInput(): void {
    if (!this.wantsConnection) return;
    this.heartbeat = this.clock();
    let changed = false;
    if (!this.state.live) { this.state.live = true; changed = true; }
    if (this.state.phase !== "Connected") { this.state.phase = "Connected"; this.state.status = "connected"; changed = true; }
    if (this.enableWhenLive) this.enableControls();
    else if (changed) this.changed();
  }

  private scheduleReconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retries += 1;
    // Retry quickly: the band advertises continuously, and we want to catch its brief connectable
    // window right after a button press rather than backing off away from it.
    const delay = Math.min(this.retries, 2);
    this.setPhase(`Reconnecting in ${delay}s…`, "reconnecting");
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!this.wantsConnection || this.quitting || !this.band) return;
      this.run(this.connectOperation(this.band));
    }, delay * 1000);
  }

  private async dispatch(action: Action, count = 1): Promise<void> {
    const title = ACTION_TITLES[action];
    try {
      for (let i = 0; i < count; i++) await this.backend.post(action);
      this.state.lastAction = `Sent: ${title}${count > 1 ? ` ×${count}` : ""}`;
      this.hooks.onAction?.({ action, title, count, ok: true });
      this.changed();
    } catch (error) {
      // One failing action shouldn't take controls down; report it and keep listening.
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastAction = `Failed: ${title}`;
      this.log.error(`${title}: ${message}`);
      this.hooks.onAction?.({ action, title, count, ok: false, error: message });
      this.changed();
    }
  }

  /// Sensor frames are flowing, so the no-data hint no longer applies.
  private markDataArrived(time: number): void {
    if (!this.wantsConnection || this.sleeping || this.sensorRecoveryPending) return;
    if (Math.abs(this.clock() - time) >= 0.6 || time < (this.lastSensorAt ?? time)) return;
    if (this.lastSensorAt === undefined || time - this.lastSensorAt > 1) this.sensorHealthySince = time;
    this.lastSensorAt = time;
    // A brief burst after reconnecting is not a recovered stream: require sustained data before
    // allowing another automatic sensor recovery.
    if (this.sensorHealthySince !== undefined && time - this.sensorHealthySince >= 30) this.sensorRecoveryUsed = false;
    this.subscribedAt = undefined;
    if (this.state.streamHint !== undefined) {
      this.state.streamHint = undefined;
      this.changed();
    }
  }

  /// Measures one motion sample's delay. Late for a second running means congested; clear again
  /// after two seconds on time.
  private measureLinkDelay(bandTimeUs: bigint, host: number): number {
    const delay = this.arrival.measure(Number(bandTimeUs) / 1e6, host);
    this.linkDelay = delay;
    this.linkDelayAt = host;
    if (delay > LATE_INPUT) {
      this.linkOnTimeSince = undefined;
      this.linkLateSince ??= host;
      if (host - this.linkLateSince >= 1) {
        if (!this.state.linkCongested) {
          this.state.linkCongested = true;
          this.releaseHeldButton();
          this.log.notice(`Band data is arriving ${delay.toFixed(2)}s late; the radio link is congested`);
          this.changed();
        }
        // Turning the motion streams off and on may clear the band's backlog. It hasn't been seen
        // to help upstream, so it's cheap: once every 20 s while data is late.
        if (host - this.lastMotionRestart >= 20) {
          this.lastMotionRestart = host;
          this.connection.restartMotionStreams();
        }
      }
    } else {
      this.linkLateSince = undefined;
      this.linkOnTimeSince ??= host;
      if (this.state.linkCongested && host - this.linkOnTimeSince >= 2) {
        this.state.linkCongested = false;
        this.log.notice("Band data is on time again");
        this.changed();
      }
    }
    return delay;
  }

  /// True when the latest motion showed a late link. Without recent motion the delay is unknown,
  /// so not late.
  private linkIsLate(now: number): boolean {
    return now - this.linkDelayAt <= 0.5 && this.linkDelay > LATE_INPUT;
  }

  /// Status replies prove the link is alive, not that its sensors are flowing.
  private evaluateStreamHint(now: number): void {
    const lastData = this.lastSensorAt ?? this.subscribedAt;
    if (!this.busy || this.sensorRecoveryPending || lastData === undefined || now - lastData < 10) return;
    const hint = this.lastSensorAt === undefined
      ? "Subscribed but no data. Is the band on your wrist and off the charger?"
      : "The sensor stream is quiet. Is the band on your wrist and off the charger?";
    if (this.state.streamHint === hint) return;
    if (this.state.streamHint === undefined) {
      this.log.notice(`No sensor frames for ${(now - lastData).toFixed(1)}s; charging: ${this.state.charging ?? "unknown"}`);
    }
    this.state.streamHint = hint;
    this.changed();
  }

  /// One watchdog, and at most one stop per recovery. The link is dead when nothing at all
  /// arrives. Sensors are stalled when status replies still arrive but motion does not; that
  /// recovery is budgeted, because an off-wrist band legitimately goes quiet and must not
  /// reconnect forever.
  private tick(): void {
    const now = this.clock();
    this.evaluateStreamHint(now);
    if (!this.wantsConnection || !this.busy || this.sleeping || this.sensorRecoveryPending) return;
    const silentFor = now - (this.heartbeat ?? this.started);
    // KINESIS_STALL overrides the 8 s no-input teardown (diagnostics: see whether the band is
    // still answering status queries before we tear the session down ourselves).
    const stallAfter = Number(process.env.KINESIS_STALL ?? 8);
    // Before the first heartbeat, allow the whole discovery window plus connect/handshake time,
    // otherwise a long KINESIS_DISCOVER gets chopped into 50 s restarts with gaps between them.
    const startupAllowance = Math.max(50, Number(process.env.KINESIS_DISCOVER ?? 60) + 40);
    const linkDead = silentFor > (this.heartbeat === undefined ? startupAllowance : stallAfter);
    const sensorsStalled = !this.sensorRecoveryUsed && this.state.charging !== true && this.lastSensorAt !== undefined
      && now - this.lastSensorAt > 10;
    if (!linkDead && !sensorsStalled) return;
    if (!linkDead) this.sensorRecoveryUsed = true;
    this.sensorRecoveryPending = true;
    if (this.state.live) {
      this.state.live = false;
      this.suspendActions();
    }
    this.setPhase(linkDead ? "Connection stalled. Reconnecting…" : "Reconnecting…", "reconnecting");
    this.log.notice(linkDead
      ? `No band input for ${silentFor.toFixed(1)}s; reconnecting`
      : `No sensor frames for ${(now - (this.lastSensorAt ?? now)).toFixed(1)}s; reconnecting once`);
    this.connection.stop();
  }
}
