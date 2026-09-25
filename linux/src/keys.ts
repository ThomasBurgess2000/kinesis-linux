// Escape and Alt for the air cursor, the way the Mac app watches Escape and Option: Escape turns
// the cursor off, and holding Alt parks the pointer so the arm can move without moving it. Wayland
// gives no app a global key monitor, so this reads the keyboards' evdev nodes directly (the same
// `input` group the virtual mouse needs), without grabbing them. Only Escape and the Alt keys are
// looked at, and only while the air cursor is on; every other key is discarded unread.

import { closeSync, constants, openSync, readFileSync, readSync } from "node:fs";
import { DEVICE_NAME } from "./uinput";

const EV_KEY = 1;
const KEY_ESC = 1, KEY_LEFTALT = 56, KEY_RIGHTALT = 100;
const EV_REP = 20;

export interface Keyboard {
  node: string;
  name: string;
}

/// Keyboards from /proc/bus/input/devices: key devices with autorepeat and an Escape key. The
/// virtual keyboards that inject shortcuts (ydotoold's, which sends the "dismiss" Escape) are left
/// out, so a mapped swipe never turns the cursor off.
export function listKeyboards(devices = readFileSync("/proc/bus/input/devices", "utf8")): Keyboard[] {
  const keyboards: Keyboard[] = [];
  for (const block of devices.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? "";
    const node = /^H: Handlers=.*\b(event\d+)\b/m.exec(block)?.[1];
    const ev = /^B: EV=([0-9a-f]+)$/m.exec(block)?.[1];
    const keys = /^B: KEY=([0-9a-f ]+)$/m.exec(block)?.[1];
    if (!node || !ev || !keys || name === DEVICE_NAME || /ydotool/i.test(name)) continue;
    if (!(BigInt(`0x${ev}`) & (1n << BigInt(EV_REP)))) continue;
    // The bitmap is printed as words, highest first; Escape is bit 1 of the lowest word.
    const lowest = keys.trim().split(/\s+/).pop() ?? "0";
    if (!(BigInt(`0x${lowest}`) & (1n << BigInt(KEY_ESC)))) continue;
    keyboards.push({ node, name });
  }
  return keyboards;
}

export interface KeyWatcherHooks {
  onEscape(): void;
  /// Either Alt key went down (true) or both are up again (false).
  onAlt(held: boolean): void;
}

/// Polls every keyboard without blocking, 50 times a second, while it runs.
export class KeyWatcher {
  private readonly open = new Map<string, number>();
  private readonly altDown = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly buffer = Buffer.alloc(24 * 64);

  constructor(private readonly hooks: KeyWatcherHooks, private readonly keyboards: () => Keyboard[] = listKeyboards) {}

  /// Starts watching. Returns how many keyboards could be read (0 when none are readable).
  start(): number {
    if (this.timer) return this.open.size;
    for (const keyboard of this.keyboards()) {
      try {
        this.open.set(keyboard.node, openSync(`/dev/input/${keyboard.node}`, constants.O_RDONLY | constants.O_NONBLOCK));
      } catch {
        // Not readable (no input group): that keyboard just can't stop or park the cursor.
      }
    }
    this.timer = setInterval(() => this.poll(), 20);
    return this.open.size;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const fd of this.open.values()) closeSync(fd);
    this.open.clear();
    if (this.altDown.size) {
      this.altDown.clear();
      this.hooks.onAlt(false);
    }
  }

  private poll(): void {
    for (const [node, fd] of this.open) {
      for (;;) {
        let count: number;
        try {
          count = readSync(fd, this.buffer);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EAGAIN") break;
          // Unplugged: forget it.
          closeSync(fd);
          this.open.delete(node);
          this.release(node);
          break;
        }
        if (count <= 0) break;
        for (let offset = 0; offset + 24 <= count; offset += 24) {
          if (this.buffer.readUInt16LE(offset + 16) !== EV_KEY) continue;
          this.key(node, this.buffer.readUInt16LE(offset + 18), this.buffer.readInt32LE(offset + 20));
          // Escape can stop the watcher, closing every keyboard.
          if (!this.timer) return;
        }
      }
    }
  }

  /// One key event from a keyboard: value 1 is a press, 0 a release, 2 an autorepeat. Exposed for
  /// tests; the polling goes through poll().
  key(node: string, code: number, value: number): void {
    if (code === KEY_ESC && value === 1) {
      this.hooks.onEscape();
    } else if (code === KEY_LEFTALT || code === KEY_RIGHTALT) {
      const id = `${node}:${code}`;
      const before = this.altDown.size > 0;
      if (value === 1) this.altDown.add(id);
      else if (value === 0) this.altDown.delete(id);
      const after = this.altDown.size > 0;
      if (before !== after) this.hooks.onAlt(after);
    }
  }

  private release(node: string): void {
    const before = this.altDown.size > 0;
    for (const id of [...this.altDown]) if (id.startsWith(`${node}:`)) this.altDown.delete(id);
    if (before && this.altDown.size === 0) this.hooks.onAlt(false);
  }
}
