#!/usr/bin/env bun
// kinesis for Linux: scan, pair, run, hand, config, actions, doctor, forget.

import { parseArgs } from "node:util";
import { ALL_ACTIONS, LoggingBackend, backendFor } from "./actions";
import * as bluez from "./bluez";
import { type Config, ConfigError, DEFAULT_CONFIG, applyConfigPatch, configPath, loadConfig, saveConfig, settingPatch } from "./config";
import { BandConnection, KinesisError, type Logger } from "./connection";
import { Controller } from "./controller";
import { Daemon, DaemonError, daemonRunning } from "./daemon";
import { describeDevice as describe, doctorRows } from "./doctor";
import { type PairProgress, claimBand, obtainMetaSession } from "./enroll";
import { BandIdentity } from "./identity";
import { MetaSessionStore } from "./meta-auth";
import { MetaSessionInvalidError } from "./meta-pair";
import {
  ACTION_TITLES, type BandDevice, type BandHand, SWIPE_DIRECTIONS, TAP_GESTURES, isAction, recognizedLabel,
} from "./gestures";

const USAGE = `kinesis — use your Meta Neural Band to control Linux

usage:
  kinesis scan [--seconds N] [--select ADDRESS]   find bands in pairing mode; remembers the strongest
  kinesis enroll [--login] [--verbose]            claim the band to your Meta account (needed once, for stable sessions)
  kinesis pair [ADDRESS]                          bond through BlueZ (only if your firmware asks for it)
  kinesis run [--practice] [--verbose]            connect and enable controls (--practice only prints)
  kinesis daemon                                  run in the background for the tray app (see packaging/)
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

/// The daemon owns the band while it runs; commands that connect would fight it for the link.
async function requireNoDaemon(): Promise<void> {
  if (await daemonRunning()) {
    fail("The Kinesis app's background service is using the band. Use the app, or stop it first:\n  systemctl --user stop kinesis.service");
  }
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
  await requireNoDaemon();
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
    onAction: (result) => console.log(`${stamp()} ${result.ok ? "Sent" : "Failed"}: ${result.title}${result.count > 1 ? ` ×${result.count}` : ""}`),
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
  const enrollment = await BandIdentity.enrollment(band.address);
  if (enrollment) console.log(`${stamp()} using enrolled band identity (${BandIdentity.path(band.address)})`);
  else console.warn(`${stamp()} no enrolled identity for this band; the session may last only ~30 s. Run \`kinesis enroll\` for a stable connection.`);
  console.log(`Connecting to ${describe(band)} with the ${backend.name} backend${values.practice ? " (practice: actions are only printed)" : ""}.`);
  controller.connect(band, { enableControls: true, ...(enrollment ? { enrollment } : {}) });
  const shutdown = async () => {
    console.log("");
    await controller.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
}

async function enroll(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { login: { type: "boolean", default: false }, verbose: { type: "boolean", default: false } } });
  await requireNoDaemon();
  const config = await loadConfig();
  const band = savedBand(config);
  const log = logger(values.verbose);
  if (await BandIdentity.exists(band.address)) {
    console.log(`This band already has an enrolled identity (${BandIdentity.path(band.address)}). Re-enrolling replaces it.`);
  }
  let shownURL = false;
  const onProgress = (progress: PairProgress) => {
    if (progress.url && !shownURL) {
      shownURL = true;
      console.log(`\nIf the browser doesn't open, paste this URL into it:\n\n  ${progress.url}\n`);
    }
    console.log(`${stamp()} ${progress.message}`);
  };
  try {
    const session = await obtainMetaSession({
      forceLogin: values.login,
      onProgress,
      askForCallback: async () => {
        console.log("\nDidn't capture the sign-in callback automatically. After signing in, the page redirects to a");
        console.log("URL like `oculus://frl_login/?...` (or `fb-viewapp://`). Paste it here, or press enter to cancel.\n");
        return prompt("Callback URL:") ?? undefined;
      },
    });
    console.log(`Signed in as Meta user ${session.userID}.`);
    console.log("\nPut the band in pairing mode (press its button) and keep it on your wrist.");
    await claimBand({ band, config, session, log, onProgress });
  } catch (error) {
    if (error instanceof MetaSessionInvalidError) {
      await MetaSessionStore.delete();
      fail("Your Meta session expired. Run `kinesis enroll --login` to sign in again.");
    }
    throw error;
  }
  console.log(`\nEnrolled and streaming. Identity saved to ${BandIdentity.path(band.address)}.`);
  console.log("Done. Run `kinesis run` (or the app) for a stable, auto-reconnecting session.");
}

async function hand(args: string[]): Promise<void> {
  const requested = args[0];
  if (requested !== "left" && requested !== "right") fail("usage: kinesis hand left|right");
  await requireNoDaemon();
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
  let next: Config;
  try {
    next = applyConfigPatch(config, settingPatch(key, value));
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message.startsWith("Unknown action") ? `${error.message}. Options: ${ALL_ACTIONS.join(", ")}` : error.message);
    throw error;
  }
  await saveConfig(next);
  console.log(`${key} = ${JSON.stringify(value)}`);
  if (await daemonRunning()) console.log("(the app's background service picks up changes on restart: systemctl --user restart kinesis.service)");
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
  const rows = await doctorRows();
  for (const { name, ok, detail } of rows) console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(22)} ${detail}`);
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}

async function daemon(): Promise<void> {
  const instance = new Daemon();
  try {
    await instance.start();
  } catch (error) {
    if (error instanceof DaemonError) fail(error.message);
    throw error;
  }
  const shutdown = async () => {
    await instance.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
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
      case "daemon": return await daemon();
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
