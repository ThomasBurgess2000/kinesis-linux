// Band pairing, shared by `kinesis enroll` and the app: find the band, sign in to Meta once, and
// claim the band with a key generated on this machine. Progress goes through a callback so the CLI
// can print it and the daemon can publish it.

import * as bluez from "./bluez";
import { canCaptureCallback, captureCallback, openInBrowser } from "./callback";
import { OwnershipCeremony } from "./ceremony";
import type { Config } from "./config";
import { type BandOperation, BandConnection, KinesisError, type Logger } from "./connection";
import type { BandDevice, BandEvent } from "./gestures";
import { type BandEnrollmentIdentity, BandIdentity } from "./identity";
import { MetaAuth, type MetaSession, MetaSessionStore, authEntryURL } from "./meta-auth";
import { MetaPairClient } from "./meta-pair";

/// The pairing steps the app shows: find → sign in → claim → ready.
export type PairStep = "find" | "signIn" | "claim" | "ready";

export interface PairProgress {
  step: PairStep;
  message: string;
  /// The Meta sign-in page, while waiting on the browser (shown in case it didn't open).
  url?: string;
}

export type OnProgress = (progress: PairProgress) => void;

/// The part of BandConnection enrollment uses; tests substitute a fake.
export interface EnrollConnection {
  readonly enrolled: BandEnrollmentIdentity | undefined;
  start(operation: BandOperation, onEvent: (event: BandEvent) => void, onEnd: (error: Error | undefined) => void): Promise<void>;
  stop(): void;
}

export class PairingCancelled extends KinesisError {
  constructor() {
    super("Pairing was cancelled.");
    this.name = "PairingCancelled";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PairingCancelled();
}

/// Scan until a band in pairing mode shows up; returns the strongest one.
export async function findBand(options: { seconds?: number; onProgress: OnProgress; signal?: AbortSignal }): Promise<BandDevice> {
  const deadline = Date.now() + (options.seconds ?? 60) * 1000;
  options.onProgress({ step: "find", message: "Hold the band's button until its light flashes." });
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    const devices = await bluez.scan(5);
    const chosen = devices.filter((d) => d.rssi !== undefined).sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127))[0];
    if (chosen) return { address: chosen.address, addressType: chosen.addressType, name: chosen.name };
  }
  throw new KinesisError("Couldn't find your band. Hold its button until the light flashes, keep it nearby, and try again.");
}

/// Reuse the saved Meta session, or sign in on Meta's own page in the browser. The temporary
/// oculus:// / fb-viewapp:// handler captures the callback; only the returned blob is seen here,
/// never the password. `askForCallback` is the fallback when capture isn't possible (the CLI
/// prompts for a paste; the app has none and fails with a message instead).
export async function obtainMetaSession(options: {
  forceLogin?: boolean;
  onProgress: OnProgress;
  askForCallback?: (url: string) => Promise<string | undefined>;
  signal?: AbortSignal;
}): Promise<MetaSession> {
  if (!options.forceLogin) {
    const saved = await MetaSessionStore.restore();
    if (saved) return saved;
  }
  options.onProgress({ step: "signIn", message: "Opening Meta's sign-in page…" });
  const tokens = await MetaAuth.tokensQuery();
  const url = authEntryURL(tokens);
  let callback: string | undefined;
  if (canCaptureCallback()) {
    callback = await captureCallback(180_000, async () => {
      const opened = await openInBrowser(url);
      options.onProgress({
        step: "signIn",
        message: opened ? "Finish signing in in your browser." : "Open the sign-in page in your browser to continue.",
        url,
      });
    }, options.signal);
  }
  throwIfAborted(options.signal);
  if (!callback && options.askForCallback) callback = (await options.askForCallback(url))?.trim();
  if (!callback) throw new KinesisError("The sign-in didn't finish. Try again.");
  const { token, blob } = MetaAuth.parseCallback(callback);
  if (!blob || !MetaAuth.callbackMatches(token, tokens.nativeSSOToken)) {
    throw new KinesisError("That sign-in didn't match this request. Try again.");
  }
  options.onProgress({ step: "signIn", message: "Finishing the sign-in…" });
  const frl = await MetaAuth.decryptBlob(blob, tokens.nativeSSOToken);
  const session = await MetaAuth.login(frl);
  await MetaSessionStore.save(session);
  return session;
}

/// Transient BLE failures (aborted connects, short-window timeouts) are worth retrying; the band
/// advertises again after each. A ceremony, HTTP, or auth failure is final.
export function isTransientEnrollFailure(message: string): boolean {
  return /abort-by-local|took too long|isn't connected or advertising|stream failed|stream ended|services never resolved|timed out/i.test(message);
}

/// The band refused because it belongs to a different Meta account (result code 0x1042).
export function isWrongAccount(error: unknown): boolean {
  return error instanceof Error && /\(0x1042\)/.test(error.message);
}

/// Claim the band for this machine: run the ownership ceremony with a fresh key, then finish the
/// trust handshake. The key is saved the moment the band confirms the ownership change, and later
/// attempts reconnect with it instead of claiming the band again.
export async function claimBand(options: {
  band: BandDevice;
  config: Config;
  session: MetaSession;
  log: Logger;
  onProgress: OnProgress;
  signal?: AbortSignal;
  attempts?: number;
  newConnection?: (log: Logger) => EnrollConnection;
  retryDelayMs?: number;
}): Promise<BandEnrollmentIdentity> {
  const { band, config, log } = options;
  const newConnection = options.newConnection ?? ((l: Logger) => new BandConnection(l));
  const pairClient = new MetaPairClient(options.session);
  const attempts = options.attempts ?? 12;
  let savedEarly: BandEnrollmentIdentity | undefined;
  options.onProgress({ step: "claim", message: "Connecting to your band…" });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(options.signal);
    const connection = newConnection(log);
    const claimed = savedEarly;
    const session = claimed
      ? { configChannel: config.configChannel, enrollment: claimed }
      : { configChannel: config.configChannel, ceremony: new OwnershipCeremony(band.address) };
    let identity: BandEnrollmentIdentity | undefined;
    const abort = () => connection.stop();
    options.signal?.addEventListener("abort", abort);
    const outcome = await new Promise<Error | undefined>((resolve) => {
      connection.start(
        { kind: "connect", band, security: config.security, session, bond: config.bond, directL2cap: config.directL2cap, psm: config.psm, pairClient },
        (event: BandEvent) => {
          if (event.payload.type === "ceremonyStage") options.onProgress({ step: "claim", message: event.payload.message });
          const adopted = connection.enrolled;
          if (adopted && adopted !== savedEarly) {
            savedEarly = adopted;
            BandIdentity.save(adopted, band.address)
              .then(() => log.notice(`band claimed; identity saved to ${BandIdentity.path(band.address)}`))
              .catch((error: unknown) => log.error(`couldn't save the new identity: ${error instanceof Error ? error.message : error}`));
          }
          if (event.payload.type === "connected") {
            identity = connection.enrolled ?? claimed;
            connection.stop();
          }
        },
        (error) => resolve(error),
      ).catch((error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))));
    });
    options.signal?.removeEventListener("abort", abort);
    throwIfAborted(options.signal);

    if (identity) {
      await BandIdentity.save(identity, band.address);
      options.onProgress({ step: "ready", message: "Your band is paired." });
      return identity;
    }
    if (outcome && !isTransientEnrollFailure(outcome.message)) throw outcome;
    const message = outcome?.message ?? "the connection closed before pairing finished";
    log.notice(`${message}; retrying (${attempt}/${attempts})…`);
    options.onProgress({
      step: "claim",
      message: savedEarly ? "Finishing up with your band…" : "Waiting for your band. Hold its button until the light flashes.",
    });
    await Bun.sleep(options.retryDelayMs ?? 1500);
  }
  throw new KinesisError("Couldn't hold a connection to the band long enough to pair. Keep it in pairing mode and try again.");
}
