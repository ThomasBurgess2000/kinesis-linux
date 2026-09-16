// Headless port of Sources/Kinesis/BandModel.swift: turns band events into desktop
// actions with the same gating, de-duplication, dial, and reconnect rules as the Mac app.

import type { ActionBackend } from "./actions";
import type { Config } from "./config";
import { type BandOperation, type Logger, now } from "./connection";
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

export interface ControllerState {
  phase: string;
  live: boolean;
  controlsEnabled: boolean;
  battery: number | undefined;
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
}

export interface ControllerHooks {
  onState?(state: ControllerState): void;
  onGesture?(gesture: RecognizedGesture): void;
  onDial?(delta: number): void;
  onHandConfirmed?(hand: BandHand): void;
}

export class Controller {
  readonly state: ControllerState = {
    phase: "Disconnected", live: false, controlsEnabled: false, battery: undefined, bandHand: "right",
    handConfirmed: false, pendingHand: undefined, handSettingError: undefined, lastGesture: "Waiting for a gesture",
    lastAction: "Controls are paused", gestureCount: 0, dialEngaged: false, pinchedFinger: undefined, error: undefined,
  };
  private wantsConnection = false;
  private busy = false;
  private quitting = false;
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

  constructor(
    private readonly config: Config,
    private readonly connection: ConnectionLike,
    private readonly backend: ActionBackend,
    private readonly log: Logger,
    private readonly hooks: ControllerHooks = {},
    private readonly clock: () => number = now,
  ) {
    this.state.bandHand = config.hand ?? "right";
    this.started = clock();
  }

  /// Connect and keep reconnecting until disconnect() is called.
  connect(band: BandDevice, options: { enableControls: boolean }): void {
    if (this.busy || this.quitting) return;
    this.band = band;
    this.wantsConnection = true;
    this.enableWhenLive = options.enableControls;
    this.retries = 0;
    this.ticker ??= setInterval(() => this.tick(), 500);
    this.run({ kind: "connect", band, security: this.config.security });
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
    this.setPhase(this.busy ? "Disconnecting…" : "Disconnected");
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

  private setPhase(phase: string): void {
    if (this.state.phase !== phase) {
      this.state.phase = phase;
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
    this.setPhase("Preparing…");
    this.state.live = false;
    this.heartbeat = undefined;
    this.state.handConfirmed = false;
    this.state.pendingHand = undefined;
    this.state.handSettingError = undefined;
    this.started = this.clock();
    this.router.reset();
    this.suspendActions();
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
    if (this.wantsConnection && !this.quitting) this.scheduleReconnect();
    else this.setPhase("Disconnected");
    this.changed();
  }

  private receive(event: BandEvent): void {
    const time = this.clock();
    const payload = event.payload;
    switch (payload.type) {
      case "devices":
        break;
      case "battery":
        this.state.battery = payload.percent;
        this.changed();
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
        this.setPhase("Preparing…");
        break;
      case "connected":
        this.setPhase("Connected");
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
    if (this.state.phase !== "Connected") { this.state.phase = "Connected"; changed = true; }
    if (this.enableWhenLive) this.enableControls();
    else if (changed) this.changed();
  }

  private scheduleReconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retries += 1;
    const delay = Math.min(2 * this.retries, 10);
    this.setPhase(`Reconnecting in ${delay}s…`);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!this.wantsConnection || this.quitting || !this.band) return;
      this.run({ kind: "connect", band: this.band, security: this.config.security });
    }, delay * 1000);
  }

  private async dispatch(action: Action, count = 1): Promise<void> {
    try {
      for (let i = 0; i < count; i++) await this.backend.post(action);
      this.state.lastAction = `Sent: ${ACTION_TITLES[action]}${count > 1 ? ` ×${count}` : ""}`;
      this.changed();
    } catch (error) {
      // One failing action shouldn't take controls down; report it and keep listening.
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastAction = `Failed: ${ACTION_TITLES[action]}`;
      this.log.error(`${ACTION_TITLES[action]}: ${message}`);
      this.changed();
    }
  }

  private tick(): void {
    if (!this.wantsConnection || !this.busy) return;
    const silentFor = this.clock() - (this.heartbeat ?? this.started);
    if (silentFor > (this.heartbeat === undefined ? 50 : 8)) {
      if (this.state.live) {
        this.state.live = false;
        this.suspendActions();
        this.setPhase("Connection stalled. Reconnecting…");
        this.log.notice(`No band input for ${silentFor.toFixed(1)}s; reconnecting`);
      }
      this.connection.stop();
    }
  }
}
