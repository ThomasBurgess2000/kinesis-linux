// The air cursor's pointer: a virtual mouse made with the kernel's uinput, the way ydotoold makes
// its keyboard. Writing /dev/uinput needs the `input` group (or a udev rule giving the seat's
// user access). Plasma treats the device like any other mouse, so moves are relative and clicks
// land wherever the pointer is; KWin is asked to give it a flat acceleration profile so libinput
// doesn't accelerate on top of the air cursor's own acceleration.

import { $ } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, openSync, readdirSync, writeSync } from "node:fs";
import type { Logger } from "./connection";

export type MouseButton = "left" | "right";

/// What the air cursor drives. Moves are whole logical pixels.
export interface PointerDevice {
  move(dx: number, dy: number): void;
  button(button: MouseButton, down: boolean): void;
  close(): void;
}

export class PointerDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PointerDeviceError";
  }
}

const EV_SYN = 0, EV_KEY = 1, EV_REL = 2;
const SYN_REPORT = 0, REL_X = 0, REL_Y = 1;
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112;
const BUS_VIRTUAL = 0x06;

// ioctl numbers: _IOC(direction, 'U', number, size).
const ioc = (direction: number, number: number, size: number): bigint =>
  (BigInt(direction) << 30n) | (BigInt(size) << 16n) | (0x55n << 8n) | BigInt(number);
const UI_DEV_CREATE = ioc(0, 1, 0);
const UI_DEV_DESTROY = ioc(0, 2, 0);
const UI_DEV_SETUP = ioc(1, 3, 92); // struct uinput_setup: input_id (8), name[80], ff_effects_max (4)
const UI_SET_EVBIT = ioc(1, 100, 4);
const UI_SET_KEYBIT = ioc(1, 101, 4);
const UI_SET_RELBIT = ioc(1, 102, 4);
const UI_GET_SYSNAME = (length: number): bigint => ioc(2, 44, length);

export const DEVICE_NAME = "Kinesis air cursor";

let libc: { symbols: { ioctl: (fd: number, request: bigint, argument: bigint | number) => number } } | undefined;

function ioctl(fd: number, request: bigint, argument: bigint | number = 0): void {
  libc ??= dlopen("libc.so.6", { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
  if (libc.symbols.ioctl(fd, request, argument) < 0) throw new PointerDeviceError("The kernel refused to set up the virtual mouse (uinput).");
}

/// input_event on 64-bit Linux: a zero timeval (the kernel stamps it), type, code, value.
function events(list: [number, number, number][]): Buffer {
  const buffer = Buffer.alloc(24 * list.length);
  list.forEach(([type, code, value], i) => {
    buffer.writeUInt16LE(type, i * 24 + 16);
    buffer.writeUInt16LE(code, i * 24 + 18);
    buffer.writeInt32LE(value, i * 24 + 20);
  });
  return buffer;
}

export class UinputPointer implements PointerDevice {
  private constructor(private fd: number | undefined, readonly eventNode: string | undefined) {}

  /// Creates the virtual mouse. Throws PointerDeviceError with what to do when it can't.
  static open(log?: Logger): UinputPointer {
    let fd: number;
    try {
      fd = openSync("/dev/uinput", constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      throw new PointerDeviceError(code === "EACCES"
        ? "The air cursor needs access to /dev/uinput. Add yourself to the input group (sudo usermod -aG input $USER), then log out and back in."
        : "The air cursor needs the uinput kernel module (/dev/uinput is missing).");
    }
    try {
      ioctl(fd, UI_SET_EVBIT, EV_KEY);
      for (const key of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) ioctl(fd, UI_SET_KEYBIT, key);
      ioctl(fd, UI_SET_EVBIT, EV_REL);
      for (const axis of [REL_X, REL_Y]) ioctl(fd, UI_SET_RELBIT, axis);
      const setup = Buffer.alloc(92);
      setup.writeUInt16LE(BUS_VIRTUAL, 0);
      setup.writeUInt16LE(0x4b49, 2); // "KI"
      setup.writeUInt16LE(0x4e45, 4); // "NE"
      setup.writeUInt16LE(1, 6);
      setup.write(DEVICE_NAME, 8, "ascii");
      ioctl(fd, UI_DEV_SETUP, BigInt(ptr(setup)));
      ioctl(fd, UI_DEV_CREATE);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const device = new UinputPointer(fd, eventNode(fd));
    if (device.eventNode) void flatAcceleration(device.eventNode, log);
    return device;
  }

  move(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.write([[EV_REL, REL_X, Math.round(dx)], [EV_REL, REL_Y, Math.round(dy)], [EV_SYN, SYN_REPORT, 0]]);
  }

  button(button: MouseButton, down: boolean): void {
    this.write([[EV_KEY, button === "left" ? BTN_LEFT : BTN_RIGHT, down ? 1 : 0], [EV_SYN, SYN_REPORT, 0]]);
  }

  close(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    this.fd = undefined;
    try { ioctl(fd, UI_DEV_DESTROY); } catch { /* closing destroys it too */ }
    closeSync(fd);
  }

  private write(list: [number, number, number][]): void {
    if (this.fd === undefined) throw new PointerDeviceError("The virtual mouse is closed.");
    try {
      writeSync(this.fd, events(list));
    } catch (error) {
      throw new PointerDeviceError(`The virtual mouse stopped accepting input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/// The device's evdev node name (e.g. "event27"), from its sysfs name.
function eventNode(fd: number): string | undefined {
  try {
    const name = Buffer.alloc(64);
    ioctl(fd, UI_GET_SYSNAME(name.length), BigInt(ptr(name)));
    const sysname = name.toString("ascii", 0, name.indexOf(0));
    return readdirSync(`/sys/devices/virtual/input/${sysname}`).find((entry) => /^event\d+$/.test(entry));
  } catch {
    return undefined;
  }
}

/// Ask KWin for a flat profile at speed 0: one uinput unit per logical pixel, with no libinput
/// acceleration. KWin picks the device up a moment after it's created, so retry briefly.
async function flatAcceleration(node: string, log?: Logger): Promise<void> {
  const gdbus = Bun.which("gdbus");
  if (!gdbus || !(process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("kde")) return;
  const set = (property: string, value: string) => $`${gdbus} call --session --dest org.kde.KWin --object-path /org/kde/KWin/InputDevice/${node} --method org.freedesktop.DBus.Properties.Set org.kde.KWin.InputDevice ${property} ${value}`.quiet().nothrow();
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await set("pointerAccelerationProfileFlat", "<true>");
    if (result.exitCode === 0) {
      await set("pointerAcceleration", "<0.0>");
      return;
    }
    await Bun.sleep(100);
  }
  log?.notice("Couldn't set a flat acceleration profile for the air cursor's virtual mouse; Plasma may accelerate it.");
}
