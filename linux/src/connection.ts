// One band connection: BlueZ for the LE link, GATT PSM and battery; a raw L2CAP
// socket for the encrypted input stream. Port of Sources/Kinesis/BandConnection.swift.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as bluez from "./bluez";
import type { CeremonyPairData, CeremonyPairRequestData } from "./ceremony";
import type { BandDevice, BandEvent, BandHand } from "./gestures";
import { L2capChannel, type SecurityLevel } from "./l2cap";
import { BandSession, type SessionOptions } from "./session";
import { concat } from "./wire";

export class KinesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KinesisError";
  }
}

/// The two ownership HTTP exchanges the enrollment ceremony pauses for.
export interface BandPairClient {
  pairRequest(data: CeremonyPairRequestData): Promise<{ signature: Uint8Array; receipt: string }>;
  pair(data: CeremonyPairData): Promise<{ signature: Uint8Array; receipt: string; devicePublicKey: Uint8Array | undefined }>;
}

export type { SessionOptions };
export type BandOperation =
  | { kind: "scan"; seconds: number }
  | { kind: "connect"; band: BandDevice; security: SecurityLevel; session?: SessionOptions; bond?: boolean; directL2cap?: boolean; psm?: number; pairClient?: BandPairClient };

export interface Logger {
  info(message: string): void;
  notice(message: string): void;
  error(message: string): void;
}

export const now = (): number => Number(Bun.nanoseconds()) / 1e9;

export function lockPath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "kinesis", "band.lock");
}

/// Prevents two kinesis processes from fighting over the band. Returns a release function.
export async function acquireLock(path = lockPath()): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const file = Bun.file(path);
  if (await file.exists()) {
    const pid = Number.parseInt((await file.text()).trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new KinesisError(`Another Kinesis connection is active (pid ${pid})`);
      } catch (error) {
        if (error instanceof KinesisError) throw error;
        // Stale lock from a process that is gone.
      }
    }
  }
  await Bun.write(path, `${process.pid}\n`);
  return async () => {
    const current = await Bun.file(path).text().catch(() => "");
    if (current.trim() === String(process.pid)) await Bun.write(path, "");
  };
}

export class BandConnection {
  private session: BandSession | undefined;
  private channel: L2capChannel | undefined;
  private device: string | undefined;
  private onEvent: ((event: BandEvent) => void) | undefined;
  private onEnd: ((error: Error | undefined) => void) | undefined;
  private operation: BandOperation | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline = Infinity;
  private lastReadAt = 0;
  private lastStatusQuery = 0;
  private nextBatteryRead = 0;
  private batteryBusy = false;
  private stopping = false;
  private disconnecting = false;
  private failure: Error | undefined;
  private release: (() => Promise<void>) | undefined;
  private pairClient: BandPairClient | undefined;
  private ceremonyBusy = false;

  constructor(private readonly log: Logger) {}

  get active(): boolean {
    return this.onEnd !== undefined;
  }

  /// The identity produced by a just-run enrollment ceremony, for the caller to persist.
  get enrolled(): import("./identity").BandEnrollmentIdentity | undefined {
    return this.session?.enrolledIdentity;
  }

  async start(operation: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void> {
    if (this.onEnd) throw new KinesisError("A band operation is already running");
    this.release = await acquireLock();
    this.operation = operation;
    this.stopping = false;
    this.disconnecting = false;
    this.failure = undefined;
    this.onEvent = onEvent;
    this.onEnd = onEnd;
    this.deadline = now() + 75;
    this.lastReadAt = now();
    this.timer = setInterval(() => this.tick(), 500);
    if (operation.kind === "scan") {
      this.scan(operation.seconds).catch((error: unknown) => this.fail(error));
    } else {
      this.pairClient = operation.pairClient;
      this.connect(operation.band, operation).catch((error: unknown) => this.fail(error));
    }
  }

  /// Ask the band to stop its streams, then close once it acknowledges (or after 3 s).
  stop(): void {
    if (!this.onEnd || this.stopping || this.disconnecting) return;
    this.stopping = true;
    try {
      const bytes = this.session?.stop() ?? new Uint8Array();
      if (bytes.length === 0 || !this.channel) {
        this.disconnect();
        return;
      }
      this.channel.write(bytes);
      this.deadline = now() + 3;
    } catch (error) {
      this.fail(error);
    }
  }

  setHandedness(hand: BandHand): void {
    if (!this.session || this.stopping || this.disconnecting || !this.channel) {
      throw new KinesisError("Connect the band before choosing a hand.");
    }
    this.channel.write(this.session.setHandedness(hand, now()));
    this.log.notice(`Requested band hand: ${hand}`);
  }

  private async scan(seconds: number): Promise<void> {
    this.deadline = now() + seconds + 20;
    const devices = await bluez.scan(seconds, (found) => {
      if (found.length) this.emit({ payload: { type: "devices", devices: found }, receivedAt: now() });
    });
    this.emit({ payload: { type: "devices", devices }, receivedAt: now() });
    this.disconnect();
  }

  private async connect(band: BandDevice, options: { security: SecurityLevel; session?: SessionOptions; bond?: boolean; directL2cap?: boolean; psm?: number }): Promise<void> {
    const security = options.security;
    const session = options.session ?? {};
    const directL2cap = options.directL2cap ?? true;
    this.emit({ payload: { type: "preparing" }, receivedAt: now() });
    await bluez.stopDiscovery().catch(() => {});
    // If the band is already connected, use that link; otherwise scan until it advertises.
    const existing = await bluez.connectedBand().catch(() => undefined);
    const found = existing ?? await bluez.discoverBand(band, Number(process.env.KINESIS_DISCOVER ?? 60));
    if (!found) throw new KinesisError("The band isn't connected or advertising. Put it in pairing mode (press its button) and try again.");
    let device = found.path;
    this.device = device;
    if (this.disconnecting) return;

    // Direct L2CAP: skip BlueZ's Device1.Connect (which times out on this band while it is in
    // pairing mode) and open the connection-oriented channel straight to the advertised address.
    // The kernel establishes the ACL. The PSM is a constant on this firmware, so no GATT read.
    if (directL2cap && !existing) {
      const psm = options.psm ?? 255;
      // Fail fast: the band accepts a connection only briefly after a button press, so a short
      // L2CAP connect timeout lets us retry into the next window instead of hanging ~30 s.
      this.deadline = now() + 14;
      this.nextBatteryRead = Infinity; // no GATT session for battery in this mode
      this.log.info(`Opening L2CAP channel on PSM ${psm} to ${found.device.address} (${found.device.addressType})`);
      this.emit({ payload: { type: "devices", devices: [found.device] }, receivedAt: now() });
      this.openChannel(session, found.device.address, found.device.addressType, psm, security, 8000);
      return;
    }

    this.log.info(`${existing ? "Using existing connection to" : "Connecting to"} ${found.device.name || band.name} (${found.device.address}, ${found.device.addressType})`);
    this.deadline = now() + 45;
    await bluez.connect(device, 18);
    if (this.disconnecting) return;
    this.log.info("Band services discovered");
    this.deadline = now() + 30;
    if (!(await bluez.hasService(device, bluez.BAND_SERVICE))) {
      throw new KinesisError("This device doesn't expose the band input service");
    }
    const psm = await this.readPsm(device);
    if (this.disconnecting) return;
    const resolved = (await bluez.deviceByPath(device)) ?? found.device;
    this.emit({ payload: { type: "devices", devices: [resolved] }, receivedAt: now() });
    this.log.info(`Opening L2CAP channel on PSM ${psm} to ${resolved.address} (${resolved.addressType})`);
    this.nextBatteryRead = now();
    this.openChannel(session, resolved.address, resolved.addressType, psm, security);
  }

  private openChannel(session: SessionOptions, address: string, addressType: "public" | "random", psm: number, security: SecurityLevel, connectTimeoutMs?: number): void {
    const channel = new L2capChannel({
      onOpen: () => { if (this.channel === channel) this.opened(session); },
      onData: (bytes) => { if (this.channel === channel) this.readInput(bytes); },
      onClose: (reason) => { if (this.channel === channel) this.channelClosed(reason); },
      onLog: (message) => this.log.info(message),
    });
    this.channel = channel;
    channel.open({ address, addressType, psm, security, ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}) });
  }

  private async readPsm(device: string): Promise<number> {
    const path = await bluez.characteristicPath(device, bluez.PSM_CHARACTERISTIC);
    if (!path) throw new KinesisError("This band doesn't expose the L2CAP PSM characteristic");
    let value: Uint8Array;
    try {
      value = await bluez.readCharacteristic(path);
    } catch (error) {
      // Firmware that requires bonding answers with an authentication error; pair once and retry.
      const message = error instanceof Error ? error.message : String(error);
      if (!/NotAuthorized|NotPermitted|Authentication|Not paired|Encrypt/i.test(message)) throw error;
      this.log.notice("The band wants a bonded link; pairing through BlueZ");
      await bluez.pair(device);
      value = await bluez.readCharacteristic(path);
    }
    if (value.length !== 2) throw new KinesisError("The band reported an unexpected PSM value");
    // Observed firmware answers ff 00: PSM 255 little-endian.
    return value[0]! | (value[1]! << 8);
  }

  private opened(session: SessionOptions): void {
    if (this.disconnecting) return;
    try {
      this.log.info("L2CAP channel opened");
      this.session = new BandSession(session);
      this.session.onFrame = (frame) => this.log.info(`  frame ch=0x${frame.channel.toString(16)} words=[${frame.words.map((w) => "0x" + w.toString(16)).join(",")}] len=${frame.length}`);
      this.channel?.write(this.session.request());
    } catch (error) {
      this.fail(error);
    }
  }

  private readInput(bytes: Uint8Array): void {
    const session = this.session;
    if (!session || this.disconnecting) return;
    try {
      const time = now();
      this.lastReadAt = time;
      const wasEnabled = session.streamsEnabled;
      const wasAuthenticated = session.authenticatedPackets > 0;
      const result = session.feed(bytes, time);
      if (!wasAuthenticated && session.authenticatedPackets > 0) this.log.info("Encrypted packet verified");
      if (!wasEnabled && session.streamsEnabled) this.log.notice("Band acknowledged gesture and motion subscription");
      // One AirShield record per SDU: the band's framing does not reassemble across writes.
      for (const packet of result.packets) this.channel?.write(packet);
      for (const event of result.events) {
        if (event.payload.type === "connected") {
          this.deadline = Infinity;
          this.log.notice("Band input subscription ready");
        } else if (event.payload.type === "ceremonyStage") {
          this.deadline = now() + 40; // the ownership ceremony makes HTTP round-trips
          this.log.notice(`Enrollment: ${event.payload.message}`);
        } else if (event.payload.type === "ceremonyHTTP") {
          this.runCeremonyHTTP(event.payload.request);
        }
        this.emit(event);
      }
      if (this.stopping && session.stopAcknowledged) this.disconnect();
    } catch (error) {
      this.fail(error);
    }
  }

  /// The ownership ceremony pauses the wire flow for a Meta HTTP round-trip. Perform it, then
  /// resume the session with the server's reply. Errors fail the connection.
  private runCeremonyHTTP(request: { kind: "pairRequest"; data: CeremonyPairRequestData } | { kind: "pair"; data: CeremonyPairData }): void {
    const session = this.session;
    const client = this.pairClient;
    if (!session || !client) {
      this.fail(new KinesisError("This band needs enrollment, but no Meta account session is available. Run `kinesis enroll`."));
      return;
    }
    this.ceremonyBusy = true;
    const resume = async (): Promise<void> => {
      if (request.kind === "pairRequest") {
        const pending = await client.pairRequest(request.data);
        this.channel?.write(session.ceremonyPairRequestCompleted(pending.signature, pending.receipt));
      } else {
        const final = await client.pair(request.data);
        this.channel?.write(session.ceremonyPairCompleted(final.signature, final.receipt, final.devicePublicKey));
      }
    };
    resume().catch((error: unknown) => this.fail(error)).finally(() => { this.ceremonyBusy = false; });
  }

  private channelClosed(reason?: string): void {
    if (this.disconnecting) {
      void this.finish();
      return;
    }
    if (this.stopping && reason === undefined) {
      this.disconnect();
      return;
    }
    this.fail(new KinesisError(reason ?? "The band input stream ended"));
  }

  private emit(event: BandEvent): void {
    if (this.disconnecting || this.stopping) return;
    if (event.payload.type === "handedness") this.log.notice(`Band hand confirmed: ${event.payload.hand}`);
    this.onEvent?.(event);
  }

  private tick(): void {
    if (!this.onEnd) return;
    const time = now();
    // Don't time out while a ceremony HTTP round-trip is in flight.
    if (this.ceremonyBusy) this.deadline = Math.max(this.deadline, time + 40);
    if (time >= this.deadline) {
      if (this.disconnecting) { void this.finish(); return; }
      if (this.stopping) { this.disconnect(); return; }
      if (this.session) {
        this.log.notice(`Startup timed out: ${this.session.authenticatedPackets} verified packets, streams enabled: ${this.session.streamsEnabled}, motion samples: ${this.session.motionMessages}`);
      }
      this.fail(new KinesisError(this.operation?.kind === "scan" ? "The scan took too long." : "The band took too long to respond. Try reconnecting."));
      return;
    }
    if (this.disconnecting) return;
    if (!this.stopping && this.device && this.session && time >= this.nextBatteryRead && !this.batteryBusy) {
      this.nextBatteryRead = time + 60;
      this.batteryBusy = true;
      const device = this.device;
      bluez.batteryPercent(device)
        .then((percent) => {
          if (percent !== undefined) this.emit({ payload: { type: "battery", percent }, receivedAt: now() });
        })
        .catch(() => {})
        .finally(() => { this.batteryBusy = false; });
    }
    const session = this.session;
    if (!this.stopping && session) {
      for (const event of session.tick(time)) this.emit(event);
      // Optional keepalive: some firmware drops the link after ~35 s of one-way streaming. A
      // periodic status query while data still flows tests whether the band wants to hear from us.
      const keepalive = Number(process.env.KINESIS_KEEPALIVE ?? 0);
      if (keepalive > 0 && session.streamsEnabled && time - this.lastStatusQuery >= keepalive) {
        try { const q = session.queryStreamState(); this.lastStatusQuery = time; if (q.length) { this.log.info("keepalive status query"); this.channel?.write(q); } }
        catch (error) { this.fail(error); }
      }
      if (session.streamsEnabled && time - this.lastReadAt >= 2 && time - this.lastStatusQuery >= 2) {
        try {
          const query = session.queryStreamState();
          this.lastStatusQuery = time;
          if (query.length) { this.log.info(`No input for ${(time - this.lastReadAt).toFixed(1)}s; sending status query`); this.channel?.write(query); }
        } catch (error) {
          this.fail(error);
        }
      }
    }
  }

  private fail(error: unknown): void {
    if (!this.onEnd || this.disconnecting) return;
    this.failure = error instanceof Error ? error : new KinesisError(String(error));
    this.log.error(`Connection error: ${this.failure.message}`);
    this.disconnect();
  }

  private disconnect(): void {
    if (this.disconnecting) return;
    this.disconnecting = true;
    if (this.stopping && this.session) {
      this.log.notice(`Band streams stopped; acknowledged: ${this.session.stopAcknowledged}`);
    }
    this.onEvent?.({ payload: { type: "disconnected" }, receivedAt: now() });
    if (this.channel) {
      this.deadline = now() + 2;
      this.channel.close();
    } else {
      void this.finish();
    }
  }

  private finishing = false;

  private async finish(): Promise<void> {
    const onEnd = this.onEnd;
    if (!onEnd || this.finishing) return;
    this.finishing = true;
    this.onEnd = undefined;
    this.onEvent = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.channel = undefined;
    this.session = undefined;
    if (this.device && this.operation?.kind === "connect") await bluez.disconnect(this.device);
    this.device = undefined;
    this.operation = undefined;
    await this.release?.();
    this.release = undefined;
    this.finishing = false;
    onEnd(this.failure);
    this.log.notice("Band connection closed");
  }
}

export { concat };
