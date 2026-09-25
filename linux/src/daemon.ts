// The background process behind the tray app: owns the band connection and serves a small local
// API over a Unix socket at $XDG_RUNTIME_DIR/kinesis/daemon.sock.
//
// Protocol: newline-delimited JSON. Requests are {id, method, params}; replies are {id, result} or
// {id, error}. The daemon also pushes {event, data} messages: state (coalesced), config, gesture,
// action, dial, and log.

import type { Socket } from "bun";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_ACTIONS, type ActionBackend, backendFor } from "./actions";
import * as bluez from "./bluez";
import { type Config, ConfigError, applyConfigPatch, configPath, loadConfig, saveConfig } from "./config";
import { BandConnection, KinesisError, type Logger } from "./connection";
import { type ActionResult, type ConnectionLike, Controller, type ControllerState, type ReadingsState } from "./controller";
import { type DoctorRow, doctorRows } from "./doctor";
import { type PairStep, PairingCancelled, claimBand, findBand, isWrongAccount, obtainMetaSession } from "./enroll";
import {
  ACTION_TITLES, type Action, type BandDevice, type BandHand, DIAL_TARGETS, type RecognizedGesture, SWIPE_DIRECTIONS,
  TAP_GESTURES, isAction, recognizedKey, recognizedLabel,
} from "./gestures";
import { BandIdentity } from "./identity";
import { MetaSessionStore } from "./meta-auth";
import { MetaSessionInvalidError } from "./meta-pair";
import { EMGReadings, RawRecorder, type ReadingsStats } from "./readings";
import { watchSleep } from "./sleep";

/// Counters that outlive a session (the Mac app keeps them in UserDefaults).
export function statsPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kinesis", "stats.json");
}

export function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || join("/tmp", `kinesis-${process.getuid?.() ?? "user"}`);
  return join(runtime, "kinesis", "daemon.sock");
}

/// Whether a daemon is answering on the socket (a leftover socket file from a crash doesn't count).
export async function daemonRunning(path = socketPath()): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise((resolve) => {
    Bun.connect({ unix: path, socket: { open(s) { s.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); } } })
      .catch(() => resolve(false));
  });
}

export interface PairingState {
  active: boolean;
  step: PairStep | null;
  message: string;
  url: string | null;
  error: string | null;
  failedStep: PairStep | null;
  /// The band belongs to a different Meta account; offer signing in with another one.
  wrongAccount: boolean;
}

export interface DaemonState {
  controller: ControllerState;
  canChangeHand: boolean;
  wantsConnection: boolean;
  band: BandDevice | null;
  enrolled: boolean;
  metaUser: string | null;
  backend: string;
  pairing: PairingState;
  setupDone: boolean;
  startAutomatically: boolean;
  /// Every gesture recognized since the app was set up, across sessions.
  totalGestures: number;
  developerMode: boolean;
  readings: ReadingsState & ReadingsStats & { recording: { path: string; frames: number } | null };
}

/// The pairing steps, swappable in tests.
export interface PairingSteps {
  findBand: typeof findBand;
  obtainMetaSession: typeof obtainMetaSession;
  claimBand: typeof claimBand;
}

export interface DaemonOptions {
  socketPath?: string;
  configPath?: string;
  connection?: ConnectionLike;
  backendFor?: (config: Config) => ActionBackend;
  log?: Logger;
  pairing?: Partial<PairingSteps>;
  doctor?: () => Promise<DoctorRow[]>;
  removeFromBluez?: (address: string) => Promise<void>;
  /// Connect on start when a band is saved and `startAutomatically` is on (default true).
  autoConnect?: boolean;
  clock?: () => number;
  statsPath?: string;
  /// Suspend/resume notifications (default: systemd-logind). Returns a stop function.
  watchSleep?: (onChange: (sleeping: boolean) => void, log: Logger) => () => void;
}

type Params = Record<string, unknown>;
type Client = Socket<{ buffer: string; queue: Buffer[] }>;

export class DaemonError extends Error {}

export class Daemon {
  private config!: Config;
  private controller!: Controller;
  private backend!: ActionBackend;
  private server: ReturnType<typeof Bun.listen<{ buffer: string; queue: Buffer[] }>> | undefined;
  private readonly clients = new Set<Client>();
  private readonly path: string;
  private readonly configFile: string;
  private readonly makeBackend: (config: Config) => ActionBackend;
  private readonly log: Logger;
  private readonly logLines: { at: string; level: string; message: string }[] = [];
  private readonly steps: PairingSteps;
  private enrolled = false;
  private metaUser: string | null = null;
  private pairing: PairingState = { active: false, step: null, message: "", url: null, error: null, failedStep: null, wrongAccount: false };
  private pairingAbort: AbortController | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private stopWatchingSleep: (() => void) | undefined;
  private totalGestures = 0;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readings = new EMGReadings();
  private readingsConfig: unknown;
  private recorder: RawRecorder | undefined;
  private emgTimer: ReturnType<typeof setInterval> | undefined;
  private emgTicks = 0;

  constructor(private readonly options: DaemonOptions = {}) {
    this.path = options.socketPath ?? socketPath();
    this.configFile = options.configPath ?? configPath();
    this.makeBackend = options.backendFor ?? ((config) => backendFor(config.backend, config.commands));
    const base = options.log ?? consoleLogger();
    this.log = {
      info: (m) => { base.info(m); this.remember("info", m); },
      notice: (m) => { base.notice(m); this.remember("notice", m); },
      error: (m) => { base.error(m); this.remember("error", m); },
    };
    this.steps = { findBand, obtainMetaSession, claimBand, ...options.pairing };
  }

  async start(): Promise<void> {
    if (await daemonRunning(this.path)) throw new DaemonError(`Another Kinesis daemon is already running (${this.path}).`);
    this.config = await loadConfig(this.configFile);
    this.backend = this.makeBackend(this.config);
    const connection = this.options.connection ?? new BandConnection(this.log);
    this.controller = new Controller(this.config, connection, this.backend, this.log, {
      onState: () => {
        const config = this.controller.state.readings.config;
        if (config && config !== this.readingsConfig) this.readings.configure(config);
        this.readingsConfig = config;
        this.stateChanged();
      },
      onRawEMG: (payload, receivedAt) => {
        this.readings.receive(payload);
        this.recorder?.record(payload, receivedAt);
      },
      onGesture: (gesture) => this.gestured(gesture),
      onAction: (result) => this.broadcast("action", result satisfies ActionResult),
      onDial: (delta) => this.broadcast("dial", { delta }),
      onHandConfirmed: (hand) => void this.handConfirmed(hand),
      onBandResolved: (device) => void this.bandResolved(device),
    }, this.options.clock);
    await this.refreshAccount();
    await this.loadStats();
    // Live EMG is a developer-mode feature; its last setting comes back with it.
    this.controller.setRawEMG(this.config.developerMode && this.config.rawEMG);
    this.emgTimer = setInterval(() => this.pushReadings(), 50);

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    if (existsSync(this.path)) unlinkSync(this.path); // a stale socket from a crashed daemon
    this.server = Bun.listen<{ buffer: string; queue: Buffer[] }>({
      unix: this.path,
      socket: {
        open: (socket) => { socket.data = { buffer: "", queue: [] }; this.clients.add(socket); },
        data: (socket, chunk) => this.received(socket, chunk),
        drain: (socket) => this.flush(socket),
        close: (socket) => { this.clients.delete(socket); },
        error: (socket) => { this.clients.delete(socket); },
      },
    });
    chmodSync(this.path, 0o600);
    this.log.notice(`Kinesis daemon listening on ${this.path}`);
    this.stopWatchingSleep = (this.options.watchSleep ?? watchSleep)((sleeping) => {
      this.log.notice(sleeping ? "Suspending: disconnecting the band" : "Resumed");
      if (sleeping) this.controller.sleep();
      else this.controller.wake();
    }, this.log);
    if ((this.options.autoConnect ?? true) && this.config.startAutomatically && this.config.band) await this.connect();
  }

  async stop(): Promise<void> {
    this.stopWatchingSleep?.();
    if (this.emgTimer) clearInterval(this.emgTimer);
    await this.stopRecording();
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      await this.saveStats();
    }
    this.pairingAbort?.abort();
    await this.controller?.disconnect();
    for (const client of this.clients) client.end();
    this.server?.stop(true);
    if (existsSync(this.path)) unlinkSync(this.path);
    if (this.stateTimer) clearTimeout(this.stateTimer);
  }

  state(): DaemonState {
    return {
      controller: structuredClone(this.controller.state),
      canChangeHand: this.controller.canChangeHand,
      wantsConnection: this.controller.wantsToConnect,
      band: this.config.band ?? null,
      enrolled: this.enrolled,
      metaUser: this.metaUser,
      backend: this.backend.name,
      pairing: { ...this.pairing },
      setupDone: this.config.setupDone,
      startAutomatically: this.config.startAutomatically,
      totalGestures: this.totalGestures,
      developerMode: this.config.developerMode,
      readings: {
        ...structuredClone(this.controller.state.readings),
        ...this.readings.stats(this.clock()),
        recording: this.recorder ? { path: this.recorder.path, frames: this.recorder.frames } : null,
      },
    };
  }

  private clock(): number {
    return (this.options.clock ?? (() => Number(Bun.nanoseconds()) / 1e9))();
  }

  /// New EMG batches go to viewers about 20 times a second, and recordings are flushed twice a second.
  private pushReadings(): void {
    this.emgTicks += 1;
    if (this.recorder && this.emgTicks % 10 === 0) this.recorder.flush();
    const { restart, batches } = this.readings.take();
    if (!restart && batches.length === 0) return;
    this.broadcast("emg", {
      restart,
      batches: batches.map((b) => ({ sequence: b.sequence.toString(), timestampUs: Number(b.timestampUs), values: b.values })),
    });
    this.stateChanged();
  }

  private async startRecording(path: unknown): Promise<void> {
    if (typeof path !== "string" || !path.startsWith("/")) throw new DaemonError("Choose where to save the recording.");
    if (!this.controller.state.readings.active) throw new DaemonError("Turn on live EMG before recording.");
    await this.stopRecording();
    try {
      this.recorder = new RawRecorder(path);
    } catch (error) {
      throw new DaemonError(`Couldn't write to ${path}: ${messageOf(error)}`);
    }
    this.log.notice(`Raw EMG capture started: ${path}`);
    this.stateChanged();
  }

  private async stopRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = undefined;
    await recorder.close();
    this.log.notice(`Raw EMG capture saved: ${recorder.frames} batches to ${recorder.path}`);
    this.stateChanged();
  }

  /// One request from a client. Exposed for tests; the socket path goes through received().
  async handle(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case "getState": return this.state();
      case "getConfig": return this.config;
      case "setConfig": return this.setConfig(params.patch);
      case "connect": await this.connect(); return this.state();
      case "disconnect": await this.controller.disconnect(); return this.state();
      case "setControls":
        if (params.enabled === true) {
          if (!this.controller.enableControls()) throw new DaemonError("Connect the band before enabling controls.");
        } else {
          this.controller.pause();
        }
        return this.state();
      case "selectHand":
        if (params.hand !== "left" && params.hand !== "right") throw new DaemonError("hand must be left or right");
        if (!this.controller.canChangeHand) throw new DaemonError("Wait for the band to confirm its hand before changing it.");
        this.controller.selectHand(params.hand);
        return this.state();
      case "listActions": return this.catalog();
      case "testAction": {
        if (!isAction(params.action) || params.action === "none") throw new DaemonError("Unknown action");
        await this.backend.post(params.action);
        return { ok: true };
      }
      case "doctor": return (this.options.doctor ?? doctorRows)();
      case "pairBand": this.pair(params.forceLogin === true); return this.state();
      case "cancelPairing": this.pairingAbort?.abort(); return this.state();
      case "signOut": await MetaSessionStore.delete(); await this.refreshAccount(); this.stateChanged(); return this.state();
      case "forget": await this.forget(); return this.state();
      case "logs": return this.logLines;
      case "startRecording": await this.startRecording(params.path); return this.state();
      case "stopRecording": await this.stopRecording(); return this.state();
      default: throw new DaemonError(`Unknown method "${method}"`);
    }
  }

  private async connect(): Promise<void> {
    const band = this.config.band;
    if (!band) throw new DaemonError("No band is paired yet.");
    const enrollment = await BandIdentity.enrollment(band.address);
    this.controller.connect(band, { enableControls: true, ...(enrollment ? { enrollment } : {}) });
  }

  private async setConfig(patch: unknown): Promise<Config> {
    let next: Config;
    try {
      next = applyConfigPatch(this.config, patch);
    } catch (error) {
      if (error instanceof ConfigError) throw new DaemonError(error.message);
      throw error;
    }
    const backendChanged = next.backend !== this.config.backend || JSON.stringify(next.commands) !== JSON.stringify(this.config.commands);
    const wantsEMG = next.developerMode && next.rawEMG;
    const emgChanged = wantsEMG !== (this.config.developerMode && this.config.rawEMG);
    this.config = next;
    if (emgChanged) {
      if (!wantsEMG) await this.stopRecording();
      this.controller.setRawEMG(wantsEMG);
    }
    if (backendChanged) this.backend = this.makeBackend(next);
    this.controller.updateConfig(next, backendChanged ? this.backend : undefined);
    await saveConfig(next, this.configFile);
    this.broadcast("config", next);
    this.stateChanged();
    return next;
  }

  private catalog(): unknown {
    return {
      actions: ALL_ACTIONS.map((id) => ({ id, title: ACTION_TITLES[id], supported: id === "none" || this.backend.supports(id) })),
      swipes: SWIPE_DIRECTIONS.map((id) => ({ id, title: `Swipe ${id}` })),
      taps: TAP_GESTURES.map((id) => ({ id, title: recognizedLabel({ kind: "tap", tap: id }) })),
      dialTargets: DIAL_TARGETS.map((id) => ({ id, title: id === "none" ? "No action" : id[0]!.toUpperCase() + id.slice(1) })),
    };
  }

  private async loadStats(): Promise<void> {
    const file = Bun.file(this.options.statsPath ?? statsPath());
    const stats = (await file.exists()) ? await file.json().catch(() => ({})) : {};
    this.totalGestures = typeof stats.totalGestures === "number" && stats.totalGestures >= 0 ? stats.totalGestures : 0;
  }

  private async saveStats(): Promise<void> {
    this.statsTimer = undefined;
    const path = this.options.statsPath ?? statsPath();
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ totalGestures: this.totalGestures }) + "\n");
  }

  private gestured(gesture: RecognizedGesture): void {
    this.totalGestures += 1;
    // Batch the writes: a burst of gestures is one save a few seconds later.
    this.statsTimer ??= setTimeout(() => void this.saveStats(), 5000);
    const action: Action = gesture.kind === "swipe" ? this.config.swipes[gesture.direction] : this.config.taps[gesture.tap];
    this.broadcast("gesture", {
      kind: gesture.kind, key: recognizedKey(gesture), label: recognizedLabel(gesture), action, actionTitle: ACTION_TITLES[action],
    });
  }

  private async handConfirmed(hand: BandHand): Promise<void> {
    if (this.config.hand === hand) return;
    this.config = { ...this.config, hand };
    this.controller.updateConfig(this.config);
    await saveConfig(this.config, this.configFile);
    this.broadcast("config", this.config);
  }

  private async bandResolved(device: BandDevice): Promise<void> {
    // Only persist a stable public identity address; the advertised random address rotates.
    const band = this.config.band;
    if (device.addressType !== "public" || !band || band.address === device.address) return;
    this.config = { ...this.config, band: { address: device.address, addressType: "public", name: device.name || band.name } };
    this.controller.updateConfig(this.config);
    await saveConfig(this.config, this.configFile);
    await this.refreshAccount();
    this.broadcast("config", this.config);
  }

  private async refreshAccount(): Promise<void> {
    this.enrolled = this.config.band ? await BandIdentity.exists(this.config.band.address) : false;
    this.metaUser = (await MetaSessionStore.restore())?.userID ?? null;
  }

  /// Pairing progress goes out immediately as its own event (claim stages arrive milliseconds
  /// apart, faster than the coalesced state), and in the next state push.
  private setPairing(pairing: PairingState): void {
    this.pairing = pairing;
    this.broadcast("pairing", { ...pairing });
    this.stateChanged();
  }

  /// Pair a band end to end: find it (unless one is saved), sign in to Meta (unless a session is
  /// saved), claim it, then connect. Runs in the background; progress is in `state.pairing`.
  private pair(forceLogin: boolean): void {
    if (this.pairing.active) return;
    const abort = new AbortController();
    this.pairingAbort = abort;
    this.setPairing({ active: true, step: "find", message: "Getting ready…", url: null, error: null, failedStep: null, wrongAccount: false });
    const progress = (p: { step: PairStep; message: string; url?: string }) => {
      this.setPairing({ ...this.pairing, step: p.step, message: p.message, url: p.url ?? null });
    };
    void (async () => {
      try {
        await this.controller.disconnect();
        let band = this.config.band;
        if (!band) {
          band = await this.steps.findBand({ onProgress: progress, signal: abort.signal });
          this.config = { ...this.config, band };
          this.controller.updateConfig(this.config);
          await saveConfig(this.config, this.configFile);
          this.broadcast("config", this.config);
        }
        const session = await this.steps.obtainMetaSession({ forceLogin, onProgress: progress, signal: abort.signal });
        await this.refreshAccount();
        const identity = await this.steps.claimBand({
          band, config: this.config, session, log: this.log, onProgress: progress, signal: abort.signal,
        });
        await this.refreshAccount();
        this.setPairing({ ...this.pairing, active: false, step: "ready", message: "Your band is paired.", url: null });
        this.controller.connect(band, { enableControls: true, enrollment: identity });
      } catch (error) {
        const failedStep = this.pairing.step;
        if (error instanceof MetaSessionInvalidError) await MetaSessionStore.delete();
        await this.refreshAccount();
        this.setPairing(error instanceof PairingCancelled
          ? { active: false, step: null, message: "", url: null, error: null, failedStep: null, wrongAccount: false }
          : {
            ...this.pairing, active: false, url: null, failedStep,
            error: error instanceof MetaSessionInvalidError ? "Your Meta sign-in expired. Sign in again." : messageOf(error),
            wrongAccount: isWrongAccount(error),
          });
        this.log.error(`pairing: ${messageOf(error)}`);
        if (this.enrolled && this.config.band) await this.connect().catch(() => {});
      } finally {
        if (this.pairingAbort === abort) this.pairingAbort = undefined;
      }
    })();
  }

  /// Forget the band everywhere on this machine: connection, BlueZ, key, Meta session. The band
  /// stays claimed on Meta's side until it's factory reset.
  private async forget(): Promise<void> {
    this.pairingAbort?.abort();
    await this.controller.disconnect();
    const band = this.config.band;
    if (band) {
      await (this.options.removeFromBluez ?? bluez.removeDevice)(band.address).catch(() => {});
      await BandIdentity.remove(band.address);
    }
    await MetaSessionStore.delete();
    const { band: _band, hand: _hand, ...rest } = this.config;
    this.config = rest;
    this.controller.updateConfig(this.config);
    await saveConfig(this.config, this.configFile);
    await this.refreshAccount();
    this.broadcast("config", this.config);
    this.stateChanged();
  }

  // --- socket plumbing ---

  private received(socket: Client, chunk: Buffer): void {
    socket.data.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = socket.data.buffer.indexOf("\n")) >= 0) {
      const line = socket.data.buffer.slice(0, newline).trim();
      socket.data.buffer = socket.data.buffer.slice(newline + 1);
      if (line) void this.request(socket, line);
    }
    if (socket.data.buffer.length > 1 << 20) socket.end(); // no request is this large
  }

  private async request(socket: Client, line: string): Promise<void> {
    let id: unknown = null;
    try {
      const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
      id = message.id ?? null;
      if (typeof message.method !== "string") throw new DaemonError("Missing method");
      const params = typeof message.params === "object" && message.params !== null ? (message.params as Params) : {};
      this.send(socket, { id, result: await this.handle(message.method, params) });
    } catch (error) {
      this.send(socket, { id, error: messageOf(error) });
    }
  }

  private send(socket: Client, message: unknown): void {
    socket.data.queue.push(Buffer.from(JSON.stringify(message, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n"));
    this.flush(socket);
  }

  private flush(socket: Client): void {
    while (socket.data.queue.length) {
      const next = socket.data.queue[0]!;
      const written = socket.write(next);
      if (written < 0) return;
      if (written < next.length) {
        socket.data.queue[0] = next.subarray(written); // bytes, so a split can't break a character
        return; // drain() resumes
      }
      socket.data.queue.shift();
    }
  }

  private broadcast(event: string, data: unknown): void {
    for (const client of this.clients) this.send(client, { event, data });
  }

  /// Coalesce state pushes to ~10 Hz; gestures and actions go out immediately as their own events.
  private stateChanged(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.broadcast("state", this.state());
    }, 100);
  }

  private remember(level: string, message: string): void {
    this.logLines.push({ at: new Date().toISOString(), level, message });
    if (this.logLines.length > 200) this.logLines.shift();
    if (level !== "info") this.broadcast("log", this.logLines[this.logLines.length - 1]);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function consoleLogger(): Logger {
  const verbose = process.env.KINESIS_VERBOSE === "1";
  return {
    info: (m) => { if (verbose) console.log(m); },
    notice: (m) => console.log(m),
    error: (m) => console.error(`error: ${m}`),
  };
}

export { KinesisError };
