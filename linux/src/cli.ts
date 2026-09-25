#!/usr/bin/env bun
// kinesis for Linux: scan, pair, run, hand, config, actions, doctor, forget.

import { parseArgs } from "node:util";
import { ALL_ACTIONS, KdeBackend, LoggingBackend, backendFor } from "./actions";
import * as bluez from "./bluez";
import { type Config, DEFAULT_CONFIG, configPath, loadConfig, saveConfig } from "./config";
import { canCaptureCallback, captureCallback, openInBrowser } from "./callback";
import { OwnershipCeremony } from "./ceremony";
import { type BandEvent } from "./gestures";
import { BandConnection, KinesisError, type Logger } from "./connection";
import { Controller } from "./controller";
import { BandIdentity } from "./identity";
import { MetaAuth, type MetaSession, MetaSessionStore, authEntryURL } from "./meta-auth";
import { MetaPairClient, MetaSessionInvalidError } from "./meta-pair";
import {
  ACTION_TITLES, type BandDevice, type BandHand, DIAL_TARGETS, type DialTarget, SWIPE_DIRECTIONS, TAP_GESTURES,
  isAction, recognizedLabel,
} from "./gestures";
import { AF_BLUETOOTH, BTPROTO_L2CAP, SOCK_SEQPACKET, libc } from "./l2cap";

const USAGE = `kinesis — use your Meta Neural Band to control Linux

usage:
  kinesis scan [--seconds N] [--select ADDRESS]   find bands in pairing mode; remembers the strongest
  kinesis enroll [--login] [--verbose]            claim the band to your Meta account (needed once, for stable sessions)
  kinesis pair [ADDRESS]                          bond through BlueZ (only if your firmware asks for it)
  kinesis run [--practice] [--verbose]            connect and enable controls (--practice only prints)
  kinesis hand left|right                         write the band's hand setting and confirm it
  kinesis config [get KEY | set KEY VALUE | path] show or change settings
  kinesis actions [--test ACTION]                 list actions and their support; test one
  kinesis doctor                                  check Bluetooth, tools, and permissions
  kinesis forget                                  drop the saved band and remove it from BlueZ

config keys: swipes.left|right|up|down  taps.indexTap|indexDoubleTap|middleTap|middleDoubleTap
             dial.target (none|volume|brightness)  dial.sensitivity (0.5–4)  backend (auto|kde|command)
             security (low|medium|high)  linkSetup (pipelined|phased)  configChannel (e.g. 0x8006)
             commands.<action> (JSON array of argv)

unpair the band from the Meta AI app first, then put it in pairing mode.`;

const stamp = (): string => new Date().toISOString().slice(11, 23);
function logger(verbose: boolean): Logger {
  return {
    info: (m) => { if (verbose) console.log(`${stamp()} ${m}`); },
    notice: (m) => console.log(`${stamp()} ${m}`),
    error: (m) => console.error(`${stamp()} error: ${m}`),
  };
}

function fail(message: string): never {
  console.error(`kinesis: ${message}`);
  process.exit(1);
}

function describe(device: BandDevice, scanning = false): string {
  const signal = device.rssi !== undefined ? `  rssi ${device.rssi}` : scanning ? "  (not advertising)" : "";
  return `${device.name || "Meta Band"}  ${device.address}  ${device.addressType}${signal}`;
}

async function scan(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { seconds: { type: "string", default: "10" }, select: { type: "string" } } });
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) fail("--seconds must be between 1 and 120");
  console.log(`Scanning for ${seconds}s. Put the band in pairing mode and keep it nearby.`);
  let shown = 0;
  const devices = await bluez.scan(seconds, (found) => {
    for (const device of found.slice(shown)) console.log(`  found ${describe(device, true)}`);
    shown = found.length;
  });
  if (devices.length === 0) fail("No band found. Put it in pairing mode, keep it nearby, and try again.");
  const config = await loadConfig();
  const chosen = values.select
    ? devices.find((d) => d.address.toUpperCase() === values.select!.toUpperCase())
    : (devices.find((d) => d.rssi !== undefined) ?? devices[0]);
  if (!chosen) fail(`No band with address ${values.select} was found.`);
  config.band = { address: chosen.address, addressType: chosen.addressType, name: chosen.name };
  await saveConfig(config);
  console.log(`Remembered ${describe(chosen)}`);
}

async function pair(args: string[]): Promise<void> {
  const config = await loadConfig();
  const address = args[0]?.toUpperCase() ?? config.band?.address;
  if (!address) fail("No band saved. Run `kinesis scan` first or pass an address.");
  const adapter = await bluez.adapterPath();
  const path = bluez.devicePath(adapter, address);
  console.log(`Pairing with ${address}. Accept the prompt from your desktop if one appears.`);
  await bluez.pair(path);
  const state = await bluez.deviceState(path);
  console.log(`Paired: ${state.paired}, bonded: ${state.bonded}, trusted: ${state.trusted}`);
}

function savedBand(config: Config): BandDevice {
  if (!config.band) fail("No band saved. Put the band in pairing mode and run `kinesis scan`.");
  return config.band;
}

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { practice: { type: "boolean", default: false }, verbose: { type: "boolean", default: false } } });
  const config = await loadConfig();
  const band = savedBand(config);
  const log = logger(values.verbose);
  const backend = values.practice ? new LoggingBackend() : backendFor(config.backend, config.commands);
  const mapped = new Set([...Object.values(config.swipes), ...Object.values(config.taps)]);
  for (const action of mapped) {
    if (action !== "none" && !backend.supports(action)) console.warn(`warning: ${ACTION_TITLES[action]} isn't available with the ${backend.name} backend`);
  }
  const connection = new BandConnection(log);
  let lastPhase = "";
  const controller = new Controller(config, connection, backend, log, {
    onState: (state) => {
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        console.log(`${stamp()} ${state.phase}${state.error ? ` — ${state.error}` : ""}`);
      }
    },
    onGesture: (gesture) => console.log(`${stamp()} gesture: ${recognizedLabel(gesture)}`),
    onHandConfirmed: async (hand) => {
      console.log(`${stamp()} band hand: ${hand}`);
      if (config.hand !== hand) { config.hand = hand; await saveConfig(config); }
    },
    onBandResolved: async (device) => {
      // Only persist a stable public identity address; the advertised random address rotates.
      if (device.addressType === "public" && config.band && config.band.address !== device.address) {
        console.log(`${stamp()} band identity resolved: ${device.address}`);
        config.band = { address: device.address, addressType: "public", name: device.name || config.band.name };
        await saveConfig(config);
      }
    },
  });
  const onAction = setInterval(() => {
    const action = controller.state.lastAction;
    if (action.startsWith("Sent") || action.startsWith("Failed")) {
      if (action !== lastAction) { lastAction = action; console.log(`${stamp()} ${action}`); }
    }
  }, 50);
  let lastAction = "";
  const enrollment = await BandIdentity.enrollment(band.address);
  if (enrollment) console.log(`${stamp()} using enrolled band identity (${BandIdentity.path(band.address)})`);
  else console.warn(`${stamp()} no enrolled identity for this band; the session may last only ~30 s. Run \`kinesis enroll\` for a stable connection.`);
  console.log(`Connecting to ${describe(band)} with the ${backend.name} backend${values.practice ? " (practice: actions are only printed)" : ""}.`);
  controller.connect(band, { enableControls: true, ...(enrollment ? { enrollment } : {}) });
  const shutdown = async () => {
    console.log("");
    clearInterval(onAction);
    await controller.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
}

/// Obtain a Meta account session: reuse a saved one, or run the webview sign-in. The user signs
/// in on Meta's own page in their browser and pastes back the fb-viewapp:// callback URL; this
/// client only ever sees the returned blob, never the password.
async function obtainMetaSession(forceLogin: boolean): Promise<MetaSession> {
  if (!forceLogin) {
    const saved = await MetaSessionStore.restore();
    if (saved) { console.log("Using saved Meta account session."); return saved; }
  }
  const tokens = await MetaAuth.tokensQuery();
  const url = authEntryURL(tokens);
  let callback: string | undefined;
  if (canCaptureCallback()) {
    console.log("\nA browser will open Meta's sign-in page. Sign in there; the callback is captured");
    console.log("automatically (a temporary handler for the oculus:// and fb-viewapp:// schemes, removed afterward).");
    console.log("\nIf the browser doesn't open, paste this URL into it manually:\n\n  " + url + "\n");
    callback = await captureCallback(180_000, async () => {
      if (!(await openInBrowser(url))) console.log("(couldn't launch a browser automatically — open the URL above)");
    });
    if (!callback) console.log("\nDidn't capture the callback automatically.");
  } else {
    console.log("\nOpen this URL in your browser and sign in to your Meta account:\n\n  " + url + "\n");
  }
  if (!callback) {
    console.log("After signing in, the page redirects to a URL like `oculus://frl_login/?...` (or `fb-viewapp://`).");
    console.log("If you can copy that URL, paste it here; otherwise press enter to cancel.\n");
    callback = (prompt("Paste the oculus:// (or fb-viewapp://) callback URL (or enter to cancel):") ?? "").trim();
  }
  if (!callback) throw new KinesisError("No callback captured. Run `kinesis enroll` again.");
  const { token, blob } = MetaAuth.parseCallback(callback);
  if (!blob || !MetaAuth.callbackMatches(token, tokens.nativeSSOToken)) {
    throw new KinesisError("That callback URL didn't match this sign-in. Start `kinesis enroll` again.");
  }
  const frl = await MetaAuth.decryptBlob(blob, tokens.nativeSSOToken);
  const session = await MetaAuth.login(frl);
  await MetaSessionStore.save(session);
  console.log(`Signed in as Meta user ${session.userID}. Session saved to ${MetaSessionStore.path()}.`);
  return session;
}

async function enroll(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { login: { type: "boolean", default: false }, verbose: { type: "boolean", default: false } } });
  const config = await loadConfig();
  const band = savedBand(config);
  const log = logger(values.verbose);
  if (await BandIdentity.exists(band.address)) {
    console.log(`This band already has an enrolled identity (${BandIdentity.path(band.address)}). Re-enrolling replaces it.`);
  }
  const session = await obtainMetaSession(values.login);
  const pairClient = new MetaPairClient(session);
  console.log("\nPut the band in pairing mode (press its button) and keep it on your wrist.");

  // Transient BLE failures (aborted connects, short-window timeouts) are worth retrying; the band
  // advertises again after each. A ceremony/HTTP/auth failure is terminal.
  const isTransient = (message: string): boolean =>
    /abort-by-local|took too long|isn't connected or advertising|stream failed|stream ended|services never resolved/i.test(message);

  // Once the band confirms the ownership change it belongs to that key; later attempts reconnect
  // with it through the enrolled trust flow instead of claiming the band again with a new key.
  let savedEarly: import("./identity").BandEnrollmentIdentity | undefined;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const connection = new BandConnection(log);
    const claimed = savedEarly;
    const sessionOptions = claimed
      ? { configChannel: config.configChannel, enrollment: claimed }
      : { configChannel: config.configChannel, ceremony: new OwnershipCeremony(band.address) };
    if (claimed) console.log(`${stamp()} reconnecting with the new identity to finish trust`);
    let identity: import("./identity").BandEnrollmentIdentity | undefined;
    const outcome = await new Promise<Error | undefined>((resolve) => {
      connection.start(
        { kind: "connect", band, security: config.security, session: sessionOptions, bond: config.bond, directL2cap: config.directL2cap, psm: config.psm, pairClient },
        (event: BandEvent) => {
          if (event.payload.type === "ceremonyStage") console.log(`${stamp()} enrollment: ${event.payload.message}`);
          // The band now belongs to the new key. Save it before the trust step, so a failure there
          // leaves a reconnectable identity instead of a band owned by a discarded key.
          const adopted = connection.enrolled;
          if (adopted && adopted !== savedEarly) {
            savedEarly = adopted;
            BandIdentity.save(adopted, band.address)
              .then(() => console.log(`${stamp()} band claimed; identity saved to ${BandIdentity.path(band.address)}`))
              .catch((error: unknown) => console.error(`${stamp()} couldn't save the new identity: ${error instanceof Error ? error.message : error}`));
          }
          if (event.payload.type === "connected") {
            identity = connection.enrolled ?? claimed;
            connection.stop();
          }
        },
        (error) => resolve(error),
      ).catch((error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))));
    });

    if (identity) {
      await BandIdentity.save(identity, band.address);
      console.log(`\nEnrolled and streaming. Identity saved to ${BandIdentity.path(band.address)}.`);
      console.log("Done. Run `kinesis run` for a stable, auto-reconnecting session.");
      return;
    }
    if (outcome instanceof MetaSessionInvalidError) {
      await MetaSessionStore.delete();
      fail("Your Meta session expired. Run `kinesis enroll --login` to sign in again.");
    }
    const message = outcome?.message ?? "the connection closed before enrollment finished";
    if (!isTransient(message)) fail(`Enrollment failed: ${message}`);
    console.log(`${stamp()} ${message}; retrying (${attempt}/12)…`);
    await Bun.sleep(1500);
  }
  fail("Couldn't hold a connection to the band long enough to enroll. Keep it in pairing mode and try again.");
}

async function hand(args: string[]): Promise<void> {
  const requested = args[0];
  if (requested !== "left" && requested !== "right") fail("usage: kinesis hand left|right");
  const config = await loadConfig();
  const band = savedBand(config);
  const log = logger(false);
  const connection = new BandConnection(log);
  let done = false;
  const controller = new Controller(config, connection, new LoggingBackend(), log, {
    onHandConfirmed: async (confirmed) => {
      if (!done && controller.canChangeHand && confirmed !== requested) {
        console.log(`Band reports ${confirmed}; switching to ${requested}…`);
        controller.selectHand(requested as BandHand);
        return;
      }
      if (confirmed === requested) {
        done = true;
        console.log(`Band hand confirmed: ${confirmed}`);
        config.hand = confirmed;
        await saveConfig(config);
        await controller.disconnect();
        process.exit(0);
      }
    },
    onState: (state) => {
      if (state.handSettingError) fail(state.handSettingError);
    },
  });
  controller.connect(band, { enableControls: false });
  setTimeout(() => fail("Timed out waiting for the band to confirm its hand."), 60_000);
  await new Promise(() => {});
}

async function configCommand(args: string[]): Promise<void> {
  const [verb, key, ...rest] = args;
  const config = await loadConfig();
  if (verb === "path") { console.log(configPath()); return; }
  if (!verb) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (verb === "get" && key) {
    const value = key.split(".").reduce<unknown>((acc, part) => (typeof acc === "object" && acc !== null ? (acc as Record<string, unknown>)[part] : undefined), config);
    console.log(JSON.stringify(value ?? null));
    return;
  }
  if (verb === "reset") {
    const band = config.band;
    const fresh: Config = structuredClone(DEFAULT_CONFIG);
    if (band) fresh.band = band;
    await saveConfig(fresh);
    console.log("Settings reset to defaults (band kept).");
    return;
  }
  if (verb !== "set" || !key) fail("usage: kinesis config [get KEY | set KEY VALUE | reset | path]");
  const value = rest.join(" ");
  const [group, name] = key.split(".") as [string, string | undefined];
  const requireAction = (): Config["swipes"]["left"] => {
    if (!isAction(value)) fail(`Unknown action "${value}". Options: ${ALL_ACTIONS.join(", ")}`);
    return value;
  };
  if (group === "swipes" && (SWIPE_DIRECTIONS as readonly string[]).includes(name ?? "")) {
    config.swipes[name as (typeof SWIPE_DIRECTIONS)[number]] = requireAction();
  } else if (group === "taps" && (TAP_GESTURES as readonly string[]).includes(name ?? "")) {
    config.taps[name as (typeof TAP_GESTURES)[number]] = requireAction();
  } else if (group === "dial" && name === "target") {
    if (!(DIAL_TARGETS as readonly string[]).includes(value)) fail(`dial.target must be one of ${DIAL_TARGETS.join(", ")}`);
    config.dial.target = value as DialTarget;
  } else if (group === "dial" && name === "sensitivity") {
    const sensitivity = Number(value);
    if (!(sensitivity >= 0.5 && sensitivity <= 4)) fail("dial.sensitivity must be between 0.5 and 4");
    config.dial.sensitivity = sensitivity;
  } else if (group === "backend" && !name) {
    if (value !== "auto" && value !== "kde" && value !== "command") fail("backend must be auto, kde, or command");
    config.backend = value;
  } else if (group === "security" && !name) {
    if (value !== "low" && value !== "medium" && value !== "high") fail("security must be low, medium, or high");
    config.security = value;
  } else if (group === "linkSetup" && !name) {
    if (value !== "pipelined" && value !== "phased") fail("linkSetup must be pipelined or phased");
    config.linkSetup = value;
  } else if (group === "configChannel" && !name) {
    const channel = value.startsWith("0x") ? parseInt(value, 16) : Number(value);
    if (!Number.isInteger(channel) || channel <= 0 || channel > 0xffff) fail("configChannel must be a 16-bit number, e.g. 0x8006 or 0x8007");
    config.configChannel = channel;
  } else if (group === "commands" && name) {
    if (!isAction(name)) fail(`Unknown action "${name}"`);
    let argv: unknown;
    try { argv = JSON.parse(value); } catch { fail("commands.<action> takes a JSON array, e.g. '[\"xdotool\",\"key\",\"Escape\"]'"); }
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) fail("commands.<action> must be an array of strings");
    if (argv.length === 0) delete config.commands[name];
    else config.commands[name] = argv;
  } else {
    fail(`Unknown setting "${key}"`);
  }
  await saveConfig(config);
  console.log(`${key} = ${JSON.stringify(value)}`);
}

async function actions(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { test: { type: "string" } } });
  const config = await loadConfig();
  const backend = backendFor(config.backend, config.commands);
  if (values.test) {
    if (!isAction(values.test)) fail(`Unknown action "${values.test}"`);
    console.log(`Sending ${ACTION_TITLES[values.test]} through the ${backend.name} backend…`);
    await backend.post(values.test);
    console.log("Done.");
    return;
  }
  console.log(`Backend: ${backend.name}\n`);
  for (const action of ALL_ACTIONS) {
    if (action === "none") continue;
    const uses = [
      ...SWIPE_DIRECTIONS.filter((d) => config.swipes[d] === action).map((d) => `swipe ${d}`),
      ...TAP_GESTURES.filter((t) => config.taps[t] === action),
    ];
    console.log(`  ${backend.supports(action) ? "✓" : "✗"} ${action.padEnd(16)} ${ACTION_TITLES[action].padEnd(22)} ${uses.join(", ")}`);
  }
  console.log(`\nDial: ${config.dial.target} at ${config.dial.sensitivity}×`);
}

async function doctor(): Promise<void> {
  const rows: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail = "") => rows.push([name, ok, detail]);
  try {
    const adapter = await bluez.adapterPath();
    check("BlueZ adapter", true, adapter);
  } catch (error) {
    check("BlueZ adapter", false, error instanceof Error ? error.message : String(error));
  }
  const fd = libc.symbols.socket(AF_BLUETOOTH, SOCK_SEQPACKET, BTPROTO_L2CAP);
  check("L2CAP socket", fd >= 0, fd >= 0 ? "kernel allows AF_BLUETOOTH sockets" : "socket() failed; check bluetooth kernel modules");
  if (fd >= 0) libc.symbols.close(fd);
  check("busctl", Bun.which("busctl") !== null, Bun.which("busctl") ?? "install systemd");
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? "";
  check("Desktop", desktop.length > 0, `${desktop || "unknown"} on ${process.env.XDG_SESSION_TYPE ?? "unknown session"}`);
  check("KDE backend", KdeBackend.available(), KdeBackend.available() ? "qdbus found" : "not KDE or qdbus missing; use the command backend");
  const ydotool = Bun.which("ydotool");
  check("ydotool", ydotool !== null, ydotool ? "used for Escape and tab switching" : "optional; needed for dismiss/previousTab/nextTab on KDE");
  const config = await loadConfig();
  check("Saved band", config.band !== undefined, config.band ? describe(config.band) : "run `kinesis scan`");
  if (config.band) {
    const known = await bluez.knownDevice(config.band.address).catch(() => undefined);
    check("Band known to BlueZ", known !== undefined, known ? describe(known) : "run `kinesis scan` with the band in pairing mode");
    if (known) {
      const adapter = await bluez.adapterPath();
      const state = await bluez.deviceState(bluez.devicePath(adapter, known.address)).catch(() => undefined);
      if (state) check("Band state", true, `connected ${state.connected}, paired ${state.paired}, trusted ${state.trusted}`);
    }
  }
  if (config.band) {
    const enrolled = await BandIdentity.exists(config.band.address);
    check("Band enrollment", enrolled, enrolled ? BandIdentity.path(config.band.address) : "run `kinesis enroll` for stable sessions");
  }
  const metaSession = await MetaSessionStore.restore();
  check("Meta session", metaSession !== undefined, metaSession ? `user ${metaSession.userID}` : "run `kinesis enroll` (sign in once)");
  check("Config", true, configPath());
  for (const [name, ok, detail] of rows) console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(20)} ${detail}`);
  if (rows.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function forget(): Promise<void> {
  const config = await loadConfig();
  const band = config.band;
  if (!band) { console.log("No band saved."); return; }
  await bluez.removeDevice(band.address).catch((error: unknown) => {
    console.warn(`BlueZ: ${error instanceof Error ? error.message : String(error)}`);
  });
  delete config.band;
  delete config.hand;
  await saveConfig(config);
  console.log(`Forgot ${describe(band)}.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "scan": return await scan(args);
      case "enroll": return await enroll(args);
      case "pair": return await pair(args);
      case "run": return await run(args);
      case "hand": return await hand(args);
      case "config": return await configCommand(args);
      case "actions": return await actions(args);
      case "doctor": return await doctor();
      case "forget": return await forget();
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof KinesisError || error instanceof bluez.BluezError) fail(error.message);
    throw error;
  }
}

await main();
