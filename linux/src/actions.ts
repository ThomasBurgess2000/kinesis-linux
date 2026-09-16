// Desktop actions. The KDE backend uses Plasma's global-shortcut D-Bus service, which
// works on Wayland without input injection; a few key-only actions go through ydotool.
// The command backend runs whatever the user configured per action.

import { $ } from "bun";
import { ACTIONS, type Action } from "./gestures";

export interface ActionBackend {
  readonly name: string;
  supports(action: Action): boolean;
  post(action: Action): Promise<void>;
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

async function run(argv: string[]): Promise<void> {
  const result = await $`${argv}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new ActionError(`${argv[0]} failed${detail ? `: ${detail}` : ""}`);
  }
}

type KdeShortcut = { component: string; shortcut: string };
type KdeSpec = KdeShortcut | { plasma: string } | { keys: string[] };

// Key names follow ydotool's `key` syntax: linux input keycodes with :1 press and :0 release.
const KEY_ESC = "1", KEY_LEFTCTRL = "29", KEY_PAGEUP = "104", KEY_PAGEDOWN = "109";

const KDE: Record<Exclude<Action, "none">, KdeSpec> = {
  previousDesktop: { component: "kwin", shortcut: "Switch One Desktop to the Left" },
  nextDesktop: { component: "kwin", shortcut: "Switch One Desktop to the Right" },
  overview: { component: "kwin", shortcut: "Overview" },
  showDesktop: { component: "kwin", shortcut: "Show Desktop" },
  previousWindow: { component: "kwin", shortcut: "Walk Through Windows (Reverse)" },
  nextWindow: { component: "kwin", shortcut: "Walk Through Windows" },
  playPause: { component: "mediacontrol", shortcut: "playpausemedia" },
  nextTrack: { component: "mediacontrol", shortcut: "nextmedia" },
  previousTrack: { component: "mediacontrol", shortcut: "previousmedia" },
  mute: { component: "kmix", shortcut: "mute" },
  volumeUp: { component: "kmix", shortcut: "increase_volume" },
  volumeDown: { component: "kmix", shortcut: "decrease_volume" },
  brightnessUp: { component: "org_kde_powerdevil", shortcut: "Increase Screen Brightness" },
  brightnessDown: { component: "org_kde_powerdevil", shortcut: "Decrease Screen Brightness" },
  launcher: { plasma: "activateLauncherMenu" },
  dismiss: { keys: [`${KEY_ESC}:1`, `${KEY_ESC}:0`] },
  previousTab: { keys: [`${KEY_LEFTCTRL}:1`, `${KEY_PAGEUP}:1`, `${KEY_PAGEUP}:0`, `${KEY_LEFTCTRL}:0`] },
  nextTab: { keys: [`${KEY_LEFTCTRL}:1`, `${KEY_PAGEDOWN}:1`, `${KEY_PAGEDOWN}:0`, `${KEY_LEFTCTRL}:0`] },
};

export class KdeBackend implements ActionBackend {
  readonly name = "kde";
  private readonly qdbus = Bun.which("qdbus6") ?? Bun.which("qdbus") ?? Bun.which("qdbus-qt6");
  private readonly ydotool = Bun.which("ydotool");

  static available(): boolean {
    const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
    return desktop.includes("kde") && (Bun.which("qdbus6") ?? Bun.which("qdbus") ?? Bun.which("qdbus-qt6")) !== null;
  }

  supports(action: Action): boolean {
    if (action === "none") return true;
    const spec = KDE[action];
    if ("keys" in spec) return this.ydotool !== null;
    return this.qdbus !== null;
  }

  async post(action: Action): Promise<void> {
    if (action === "none") return;
    const spec = KDE[action];
    if ("keys" in spec) {
      if (!this.ydotool) throw new ActionError(`${action} needs ydotool (with ydotoold running) for key events`);
      await run([this.ydotool, "key", ...spec.keys]);
      return;
    }
    if (!this.qdbus) throw new ActionError("qdbus is required for KDE actions (install qt6-tools or qdbus-qt6)");
    if ("plasma" in spec) {
      await run([this.qdbus, "org.kde.plasmashell", "/PlasmaShell", `org.kde.PlasmaShell.${spec.plasma}`]);
      return;
    }
    await run([this.qdbus, "org.kde.kglobalaccel", `/component/${spec.component}`,
      "org.kde.kglobalaccel.Component.invokeShortcut", spec.shortcut]);
  }
}

/// Runs user-configured argv arrays. Unmapped actions are reported as unsupported.
export class CommandBackend implements ActionBackend {
  readonly name = "command";
  constructor(private readonly commands: Partial<Record<Action, string[]>>) {}

  supports(action: Action): boolean {
    return action === "none" || (this.commands[action]?.length ?? 0) > 0;
  }

  async post(action: Action): Promise<void> {
    if (action === "none") return;
    const argv = this.commands[action];
    if (!argv || argv.length === 0) throw new ActionError(`No command configured for ${action}`);
    await run(argv);
  }
}

/// Records actions instead of performing them. Used by tests and `run --practice`.
export class LoggingBackend implements ActionBackend {
  readonly name = "log";
  readonly posted: Action[] = [];
  supports(): boolean { return true; }
  async post(action: Action): Promise<void> { this.posted.push(action); }
}

export function backendFor(kind: "auto" | "kde" | "command", commands: Partial<Record<Action, string[]>>): ActionBackend {
  const overridden = Object.keys(commands).filter((key) => (commands as Record<string, string[]>)[key]?.length);
  if (kind === "command") return new CommandBackend(commands);
  if (kind === "kde" || KdeBackend.available()) {
    const kde = new KdeBackend();
    if (overridden.length === 0) return kde;
    // Per-action command overrides take precedence over the KDE mapping.
    const command = new CommandBackend(commands);
    return {
      name: "kde+command",
      supports: (action) => (command.supports(action) && action !== "none") || kde.supports(action),
      post: (action) => (command.supports(action) && action !== "none" ? command.post(action) : kde.post(action)),
    };
  }
  return new CommandBackend(commands);
}

export const ALL_ACTIONS: readonly Action[] = ACTIONS;
