// Persistent settings at $XDG_CONFIG_HOME/kinesis/config.json.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Action, type BandDevice, type BandHand, DIAL_TARGETS, type DialTarget, SWIPE_DIRECTIONS, type SwipeDirection,
  TAP_GESTURES, type TapGesture, isAction,
} from "./gestures";
import type { SecurityLevel } from "./l2cap";

export interface Config {
  band?: BandDevice;
  hand?: BandHand;
  swipes: Record<SwipeDirection, Action>;
  taps: Record<TapGesture, Action>;
  dial: { target: DialTarget; sensitivity: number };
  backend: "auto" | "kde" | "command";
  commands: Partial<Record<Action, string[]>>;
  security: SecurityLevel;
  linkSetup: "pipelined" | "phased";
  configChannel: number;
  bond: boolean;
  directL2cap: boolean;
  psm: number;
}

export const DEFAULT_CONFIG: Config = {
  swipes: { left: "previousDesktop", right: "nextDesktop", up: "overview", down: "dismiss" },
  taps: { indexTap: "none", indexDoubleTap: "playPause", middleTap: "none", middleDoubleTap: "mute" },
  dial: { target: "volume", sensitivity: 1 },
  backend: "auto",
  commands: {},
  security: "low",
  linkSetup: "pipelined",
  configChannel: 0x8006,
  bond: false,
  directL2cap: true,
  psm: 255,
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "kinesis", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// Merges a parsed file over the defaults, dropping anything malformed rather than failing.
export function normalize(raw: unknown): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  if (!isRecord(raw)) return config;
  if (isRecord(raw.band) && typeof raw.band.address === "string" && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(raw.band.address)) {
    config.band = {
      address: raw.band.address.toUpperCase(),
      addressType: raw.band.addressType === "random" ? "random" : "public",
      name: typeof raw.band.name === "string" ? raw.band.name : "Meta Band",
    };
  }
  if (raw.hand === "left" || raw.hand === "right") config.hand = raw.hand;
  if (isRecord(raw.swipes)) {
    for (const direction of SWIPE_DIRECTIONS) if (isAction(raw.swipes[direction])) config.swipes[direction] = raw.swipes[direction];
  }
  if (isRecord(raw.taps)) {
    for (const tap of TAP_GESTURES) if (isAction(raw.taps[tap])) config.taps[tap] = raw.taps[tap];
  }
  if (isRecord(raw.dial)) {
    if ((DIAL_TARGETS as readonly unknown[]).includes(raw.dial.target)) config.dial.target = raw.dial.target as DialTarget;
    if (typeof raw.dial.sensitivity === "number" && raw.dial.sensitivity >= 0.5 && raw.dial.sensitivity <= 4) {
      config.dial.sensitivity = raw.dial.sensitivity;
    }
  }
  if (raw.backend === "kde" || raw.backend === "command" || raw.backend === "auto") config.backend = raw.backend;
  if (isRecord(raw.commands)) {
    for (const [key, value] of Object.entries(raw.commands)) {
      if (isAction(key) && Array.isArray(value) && value.every((v) => typeof v === "string")) config.commands[key] = value;
    }
  }
  if (raw.security === "low" || raw.security === "medium" || raw.security === "high") config.security = raw.security;
  if (raw.linkSetup === "pipelined" || raw.linkSetup === "phased") config.linkSetup = raw.linkSetup;
  if (typeof raw.configChannel === "number" && Number.isInteger(raw.configChannel) && raw.configChannel > 0 && raw.configChannel <= 0xffff) {
    config.configChannel = raw.configChannel;
  }
  if (typeof raw.bond === "boolean") config.bond = raw.bond;
  if (typeof raw.directL2cap === "boolean") config.directL2cap = raw.directL2cap;
  if (typeof raw.psm === "number" && Number.isInteger(raw.psm) && raw.psm > 0 && raw.psm <= 0xffff) config.psm = raw.psm;
  return config;
}

export async function loadConfig(path = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return structuredClone(DEFAULT_CONFIG);
  try {
    return normalize(await file.json());
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
}
