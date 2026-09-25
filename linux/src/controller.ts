// Headless port of Sources/Kinesis/BandModel.swift: turns band events into desktop
// actions with the same gating, de-duplication, dial, and reconnect rules as the Mac app.

import type { ActionBackend } from "./actions";
import type { Config } from "./config";
import { type BandOperation, type Logger, now } from "./connection";
import type { BandEnrollmentIdentity } from "./identity";
import {
  ACTION_TITLES, type Action, ActionGate, type BandDevice, type BandEvent, type BandHand, DialRouter, GestureRouter,
  type RecognizedGesture, type SwipeDirection, dialAction, gestureLabel, recognizedLabel,
} from "./gestures";

export interface ConnectionLike {
  readonly active: boolean;
  start(operation: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void>;
  stop(): void;
  setHandedness(hand: BandHand): void;
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
}

export interface ControllerHooks {
  onState?(state: ControllerState): void;
  onGesture?(gesture: RecognizedGesture): void;
  onDial?(delta: number): void;
  onAction?(result: ActionResult): void;
  onHandConfirmed?(hand: BandHand): void;
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

  constructor(
    private config: Config,
    private readonly connection: ConnectionLike,
    private backend: ActionBackend,
    private readonly log: Logger,
    private readonly hooks: ControllerHooks = {},
    private readonly clock: () => number = now,
  ) {
    this.state.bandHand = config.hand ?? "right";
    this.started = clock();
  }

  private connectOperation(band: BandDevice): BandOperation {
    return {
      kind: "connect", band, security: this.config.security,
      session: { configChannel: this.config.configChannel, ...(this.enrollment ? { enrollment: this.enrollment } : {}) },
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
    this.hooks.onState?.(this.state);
  }

  private resetDial(): void {
    this.dialArmed = false;
    this.dialGate.pause();
    this.dialRouter.reset();
  }

  private suspendActions(): void {
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
    this.state.streamHint = undefined;
    this.state.linkCongested = false;
    this.state.awaitingSystemPairing = false;
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
        this.state.handConfirmed = true;
        this.state.pendingHand = undefined;
        this.state.handSettingError = undefined;
        this.hooks.onHandConfirmed?.(payload.hand);
        this.changed();
        break;
      case "handednessFailure":
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
        this.measureLinkDelay(payload.bandTimeUs, event.receivedAt);
        break;
      case "subscribed":
        this.subscribedAt = time;
        break;
      case "systemPairingPending":
        this.state.awaitingSystemPairing = true;
        this.changed();
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
        const label = gestureLabel(message);
        if (label && this.state.lastGesture !== label) this.state.lastGesture = label;
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
        if (!this.state.live || this.state.pendingHand !== undefined || Math.abs(time - event.receivedAt) > 0.35) { this.resetDial(); return; }
        this.state.dialEngaged = payload.engaged;
        this.resetDial();
        if (payload.engaged && this.state.controlsEnabled) {
          this.dialArmed = true;
          this.dialGate.arm(event.receivedAt);
        }
        this.changed();
        break;
      case "dialTurn": {
        if (!this.state.live || !this.state.handConfirmed || !this.state.dialEngaged) return;
        if (Math.abs(time - event.receivedAt) > 0.35 || !Number.isFinite(payload.rotation)) return;
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

  /// Late for a second running means congested; clear again after two seconds on time.
  private measureLinkDelay(bandTimeUs: bigint, host: number): void {
    const delay = this.arrival.measure(Number(bandTimeUs) / 1e6, host);
    if (delay > LATE_INPUT) {
      this.linkOnTimeSince = undefined;
      this.linkLateSince ??= host;
      if (host - this.linkLateSince >= 1 && !this.state.linkCongested) {
        this.state.linkCongested = true;
        this.log.notice(`Band data is arriving ${delay.toFixed(2)}s late; the radio link is congested`);
        this.changed();
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
