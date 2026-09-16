// LE L2CAP connection-oriented channel through the kernel's AF_BLUETOOTH socket API.
// Reads block inside a Worker (see l2cap-worker.ts); writes go straight to the fd.

import { FFIType, dlopen, ptr, read as ffiRead, toArrayBuffer } from "bun:ffi";

export const AF_BLUETOOTH = 31;
export const SOCK_SEQPACKET = 5;
export const SOCK_CLOEXEC = 0o2000000;
export const BTPROTO_L2CAP = 0;
export const SOL_BLUETOOTH = 274;
export const BT_SECURITY = 4;
export const BT_RCVMTU = 13;
export const BDADDR_LE_PUBLIC = 1;
export const BDADDR_LE_RANDOM = 2;
export const SECURITY_LEVELS = { low: 1, medium: 2, high: 3 } as const;
export type SecurityLevel = keyof typeof SECURITY_LEVELS;

export const libc = dlopen("libc.so.6", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  __errno_location: { args: [], returns: FFIType.ptr },
});

export function errno(): number {
  const location = libc.symbols.__errno_location();
  return location ? ffiRead.i32(location, 0) : 0;
}

export function errnoMessage(code = errno()): string {
  const text = libc.symbols.strerror(code);
  return `${text ?? "error"} (errno ${code})`;
}

/// struct sockaddr_l2 { u16 family; le16 psm; bdaddr_t (6 bytes, reversed); le16 cid; u8 type; }
export function sockaddrL2(address: string, addressType: number, psm: number): Uint8Array {
  const out = new Uint8Array(14);
  const view = new DataView(out.buffer);
  view.setUint16(0, AF_BLUETOOTH, true);
  view.setUint16(2, psm, true);
  const octets = address.split(":").map((part) => parseInt(part, 16));
  if (octets.length !== 6 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`Invalid Bluetooth address: ${address}`);
  }
  for (let i = 0; i < 6; i++) out[4 + i] = octets[5 - i]!;
  view.setUint16(10, 0, true);
  out[12] = addressType;
  return out;
}

export interface L2capOptions {
  address: string;
  addressType: "public" | "random";
  psm: number;
  security: SecurityLevel;
  receiveMtu?: number;
}

/// Creates, configures, and connects the socket. Blocking; run inside the worker.
export function openL2cap(options: L2capOptions): number {
  const fd = libc.symbols.socket(AF_BLUETOOTH, SOCK_SEQPACKET | SOCK_CLOEXEC, BTPROTO_L2CAP);
  if (fd < 0) throw new Error(`Could not create an L2CAP socket: ${errnoMessage()}`);
  try {
    const local = sockaddrL2("00:00:00:00:00:00", BDADDR_LE_PUBLIC, 0);
    if (libc.symbols.bind(fd, ptr(local), local.length) < 0) {
      throw new Error(`Could not bind the L2CAP socket: ${errnoMessage()}`);
    }
    const security = new Uint8Array([SECURITY_LEVELS[options.security], 0]);
    if (libc.symbols.setsockopt(fd, SOL_BLUETOOTH, BT_SECURITY, ptr(security), security.length) < 0) {
      throw new Error(`Could not set the L2CAP security level: ${errnoMessage()}`);
    }
    const mtu = new Uint16Array([options.receiveMtu ?? 8192]);
    // Older kernels reject a receive MTU on unconnected LE sockets; the default still carries band frames.
    libc.symbols.setsockopt(fd, SOL_BLUETOOTH, BT_RCVMTU, ptr(mtu), 2);
    const remote = sockaddrL2(options.address, options.addressType === "random" ? BDADDR_LE_RANDOM : BDADDR_LE_PUBLIC, options.psm);
    if (libc.symbols.connect(fd, ptr(remote), remote.length) < 0) {
      throw new Error(`Could not open the band's L2CAP channel (PSM ${options.psm}): ${errnoMessage()}`);
    }
    return fd;
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
}

export function writeAll(fd: number, data: Uint8Array): void {
  // SEQPACKET preserves message boundaries; one write is one SDU to the band.
  const count = libc.symbols.write(fd, ptr(data), BigInt(data.length));
  if (Number(count) !== data.length) {
    throw new Error(`Could not write to the band: ${Number(count) < 0 ? errnoMessage() : "short write"}`);
  }
}

export function makePipe(): [number, number] {
  const fds = new Int32Array(2);
  if (libc.symbols.pipe2(ptr(fds), SOCK_CLOEXEC) < 0) throw new Error(`Could not create a pipe: ${errnoMessage()}`);
  return [fds[0]!, fds[1]!];
}

export type WorkerCommand =
  | { type: "open"; options: L2capOptions; wakeFd: number }
  // Tests hand the worker an already-connected descriptor (e.g. one end of a socketpair).
  | { type: "adopt"; fd: number; wakeFd: number };
export type WorkerMessage =
  | { type: "opened"; fd: number }
  | { type: "data"; bytes: ArrayBuffer }
  | { type: "closed"; reason?: string }
  | { type: "error"; message: string };

/// Owns the socket lifetime. `onData` is called on the main thread with each received SDU.
export class L2capChannel {
  private worker: Worker | undefined;
  private fd = -1;
  private wake: [number, number] | undefined;
  private closed = false;

  constructor(
    private readonly handlers: {
      onOpen: () => void;
      onData: (bytes: Uint8Array) => void;
      onClose: (reason?: string) => void;
    },
  ) {}

  open(options: L2capOptions): void {
    this.launch({ type: "open", options, wakeFd: this.prepare() });
  }

  /// Test hook: drive the same worker loop over an existing connected descriptor.
  adopt(fd: number): void {
    this.launch({ type: "adopt", fd, wakeFd: this.prepare() });
  }

  private prepare(): number {
    if (this.worker) throw new Error("L2CAP channel already opened");
    this.wake = makePipe();
    return this.wake[0];
  }

  private launch(command: WorkerCommand): void {
    this.worker = new Worker(new URL("./l2cap-worker.ts", import.meta.url).href);
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "opened":
          this.fd = message.fd;
          this.handlers.onOpen();
          break;
        case "data":
          if (!this.closed) this.handlers.onData(new Uint8Array(message.bytes));
          break;
        case "closed":
          this.finish(message.reason);
          break;
        case "error":
          this.finish(message.message);
          break;
      }
    };
    this.worker.onerror = (event) => this.finish(event.message || "L2CAP worker failed");
    this.worker.postMessage(command);
  }

  write(data: Uint8Array): void {
    if (this.closed || this.fd < 0 || data.length === 0) return;
    writeAll(this.fd, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.wake) {
      const byte = new Uint8Array([1]);
      libc.symbols.write(this.wake[1], ptr(byte), 1n);
    }
  }

  private finish(reason?: string): void {
    const wasClosed = this.closed;
    this.closed = true;
    if (this.wake) {
      libc.symbols.close(this.wake[0]);
      libc.symbols.close(this.wake[1]);
      this.wake = undefined;
    }
    this.worker?.terminate();
    this.worker = undefined;
    this.fd = -1;
    this.handlers.onClose(wasClosed && reason === undefined ? undefined : reason);
  }
}

export { toArrayBuffer };
