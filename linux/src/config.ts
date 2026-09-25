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
  /// The app's first-run setup has been finished or skipped.
  setupDone: boolean;
  /// The daemon connects and enables controls as soon as it starts.
  startAutomatically: boolean;
  /// Developer mode unlocks the readings page (live raw sEMG and recording).
  developerMode: boolean;
  /// Live raw sEMG was on (restored when developer mode is on).
  rawEMG: boolean;
  /// The air cursor's levers (developer mode).
  cursor: CursorSettings;
}

export interface CursorSettings {
  /// Points the pointer moves per degree of arm turn, before acceleration.
  speed: number;
  /// How much quick moves speed up: the top acceleration factor.
  flickBoost: number;
  /// 0 is the most responsive and 1 the steadiest.
  steadiness: number;
}

/// Each cursor lever's range, as the Mac app's sliders allow.
export const CURSOR_LIMITS: Record<keyof CursorSettings, [number, number]> = {
  speed: [20, 100],
  flickBoost: [1, 2.5],
  steadiness: [0, 1],
};

export const DEFAULT_CURSOR: CursorSettings = { speed: 45, flickBoost: 1.6, steadiness: 0.5 };

function isCursorSetting(name: string): name is keyof CursorSettings {
  return Object.hasOwn(CURSOR_LIMITS, name);
}

export const DEFAULT_CONFIG: Config = {
  swipes: { left: "previousDesktop", right: "nextDesktop", up: "overview", down: "dismiss" },
  taps: { indexTap: "none", indexDoubleTap: "playPause", middleTap: "none", middleDoubleTap: "mute", middleHold: "none" },
  dial: { target: "volume", sensitivity: 1 },
  backend: "auto",
  commands: {},
  security: "low",
  linkSetup: "pipelined",
  configChannel: 0x8006,
  bond: false, // not needed: the ~37 s stalls were the kernel credit-ident bug (see kernel-fix/)
  directL2cap: true,
  psm: 255,
  setupDone: false,
  startAutomatically: true,
  developerMode: false,
  rawEMG: false,
  cursor: { ...DEFAULT_CURSOR },
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
  if (typeof raw.setupDone === "boolean") config.setupDone = raw.setupDone;
  if (typeof raw.startAutomatically === "boolean") config.startAutomatically = raw.startAutomatically;
  if (typeof raw.developerMode === "boolean") config.developerMode = raw.developerMode;
  if (typeof raw.rawEMG === "boolean") config.rawEMG = raw.rawEMG;
  if (isRecord(raw.cursor)) {
    for (const [name, value] of Object.entries(raw.cursor)) {
      if (!isCursorSetting(name) || typeof value !== "number") continue;
      const [low, high] = CURSOR_LIMITS[name];
      if (value >= low && value <= high) config.cursor[name] = value;
    }
  }
  return config;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/// Apply a partial settings object (e.g. `{ swipes: { left: "mute" }, dial: { sensitivity: 2 } }`)
/// to a copy of `config`. Unlike normalize(), anything invalid is an error the caller reports, so
/// the CLI's `config set` and the app's settings share one set of rules and messages.
export function applyConfigPatch(config: Config, patch: unknown): Config {
  if (!isRecord(patch)) throw new ConfigError("Settings must be an object");
  const next: Config = structuredClone(config);
  const requireAction = (value: unknown): Action => {
    if (!isAction(value)) throw new ConfigError(`Unknown action "${String(value)}"`);
    return value;
  };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "swipes":
      case "taps": {
        if (!isRecord(value)) throw new ConfigError(`${key} must be an object`);
        const names: readonly string[] = key === "swipes" ? SWIPE_DIRECTIONS : TAP_GESTURES;
        for (const [name, action] of Object.entries(value)) {
          if (!names.includes(name)) throw new ConfigError(`Unknown setting "${key}.${name}"`);
          (next[key] as Record<string, Action>)[name] = requireAction(action);
        }
        break;
      }
      case "dial": {
        if (!isRecord(value)) throw new ConfigError("dial must be an object");
        for (const [name, v] of Object.entries(value)) {
          if (name === "target") {
            if (!(DIAL_TARGETS as readonly unknown[]).includes(v)) throw new ConfigError(`dial.target must be one of ${DIAL_TARGETS.join(", ")}`);
            next.dial.target = v as DialTarget;
          } else if (name === "sensitivity") {
            if (typeof v !== "number" || !(v >= 0.5 && v <= 4)) throw new ConfigError("dial.sensitivity must be between 0.5 and 4");
            next.dial.sensitivity = v;
          } else {
            throw new ConfigError(`Unknown setting "dial.${name}"`);
          }
        }
        break;
      }
      case "cursor": {
        if (!isRecord(value)) throw new ConfigError("cursor must be an object");
        for (const [name, v] of Object.entries(value)) {
          if (!isCursorSetting(name)) throw new ConfigError(`Unknown setting "cursor.${name}"`);
          const [low, high] = CURSOR_LIMITS[name];
          if (typeof v !== "number" || !(v >= low && v <= high)) throw new ConfigError(`cursor.${name} must be between ${low} and ${high}`);
          next.cursor[name] = v;
        }
        break;
      }
      case "backend":
        if (value !== "auto" && value !== "kde" && value !== "command") throw new ConfigError("backend must be auto, kde, or command");
        next.backend = value;
        break;
      case "security":
        if (value !== "low" && value !== "medium" && value !== "high") throw new ConfigError("security must be low, medium, or high");
        next.security = value;
        break;
      case "linkSetup":
        if (value !== "pipelined" && value !== "phased") throw new ConfigError("linkSetup must be pipelined or phased");
        next.linkSetup = value;
        break;
      case "configChannel":
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 0xffff) {
          throw new ConfigError("configChannel must be a 16-bit number, e.g. 0x8006 or 0x8007");
        }
        next.configChannel = value;
        break;
      case "commands": {
        if (!isRecord(value)) throw new ConfigError("commands must be an object");
        for (const [name, argv] of Object.entries(value)) {
          if (!isAction(name)) throw new ConfigError(`Unknown action "${name}"`);
          if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) {
            throw new ConfigError("commands.<action> must be an array of strings");
          }
          if (argv.length === 0) delete next.commands[name];
          else next.commands[name] = argv;
        }
        break;
      }
      case "bond":
      case "directL2cap":
      case "setupDone":
      case "startAutomatically":
      case "developerMode":
      case "rawEMG":
        if (typeof value !== "boolean") throw new ConfigError(`${key} must be true or false`);
        next[key] = value;
        break;
      default:
        throw new ConfigError(`Unknown setting "${key}"`);
    }
  }
  return next;
}

/// Turn the CLI's `config set KEY VALUE` into a patch for applyConfigPatch().
export function settingPatch(key: string, value: string): Record<string, unknown> {
  const [group, name, ...extra] = key.split(".");
  if (!group || extra.length) throw new ConfigError(`Unknown setting "${key}"`);
  let parsed: unknown = value;
  if (group === "commands") {
    try { parsed = JSON.parse(value); } catch { throw new ConfigError("commands.<action> takes a JSON array, e.g. '[\"xdotool\",\"key\",\"Escape\"]'"); }
  } else if ((group === "dial" && name === "sensitivity") || group === "cursor") {
    parsed = Number(value);
  } else if (group === "configChannel") {
    parsed = value.startsWith("0x") ? parseInt(value, 16) : Number(value);
  } else if (["bond", "directL2cap", "setupDone", "startAutomatically", "developerMode", "rawEMG"].includes(group)) {
    parsed = value === "true" ? true : value === "false" ? false : value;
  }
  return name === undefined ? { [group]: parsed } : { [group]: { [name]: parsed } };
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
