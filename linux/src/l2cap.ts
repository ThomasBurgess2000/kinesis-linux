// LE L2CAP connection-oriented channel through the kernel's AF_BLUETOOTH socket API.
// Reads block inside a Worker (see l2cap-worker.ts); writes go straight to the fd.

import { FFIType, dlopen, ptr, read as ffiRead, toArrayBuffer } from "bun:ffi";

export const AF_BLUETOOTH = 31;
export const SOCK_SEQPACKET = 5;
export const SOCK_CLOEXEC = 0o2000000;
export const BTPROTO_L2CAP = 0;
export const SOL_BLUETOOTH = 274;
export const BT_SECURITY = 4;
export const BT_SNDMTU = 12;
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
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});

const F_GETFL = 3, F_SETFL = 4, O_NONBLOCK = 0o4000, EINPROGRESS = 115, EINTR = 4;
const SOL_SOCKET = 1, SO_ERROR = 4;
export const POLLIN = 0x001, POLLOUT = 0x004, POLLERR = 0x008, POLLHUP = 0x010, POLLNVAL = 0x020;

export class L2capCancelled extends Error {
  constructor() {
    super("L2CAP connect cancelled");
    this.name = "L2capCancelled";
  }
}

/// Builds a pollfd array; each entry is (fd:i32, events:i16, revents:i16).
export function pollfds(entries: { fd: number; events: number }[]): { buffer: Uint8Array; revents: (index: number) => number } {
  const buffer = new Uint8Array(8 * entries.length);
  const view = new DataView(buffer.buffer);
  entries.forEach((entry, i) => {
    view.setInt32(i * 8, entry.fd, true);
    view.setInt16(i * 8 + 4, entry.events, true);
  });
  return { buffer, revents: (index) => view.getInt16(index * 8 + 6, true) };
}

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
  log?: (message: string) => void;
}

/// Reads a u16 Bluetooth socket option (BT_SNDMTU is the peer's MTU, BT_RCVMTU ours).
export function socketMtu(fd: number, option: number): number {
  const value = new Uint16Array(1);
  const length = new Uint32Array([2]);
  return libc.symbols.getsockopt(fd, SOL_BLUETOOTH, option, ptr(value), ptr(length)) < 0 ? -1 : value[0]!;
}

/// Creates, configures, and connects the socket. Runs inside the worker. The connect is
/// non-blocking so a byte on `wakeFd` can abort it; the kernel's own LE connect timeout
/// otherwise decides how long an unreachable band takes to fail.
export function openL2cap(options: L2capOptions, wakeFd?: number, timeoutMs = 40_000): number {
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
    if (libc.symbols.setsockopt(fd, SOL_BLUETOOTH, BT_RCVMTU, ptr(mtu), 2) < 0) {
      options.log?.(`BT_RCVMTU ${mtu[0]} rejected: ${errnoMessage()}`);
    }
    const remote = sockaddrL2(options.address, options.addressType === "random" ? BDADDR_LE_RANDOM : BDADDR_LE_PUBLIC, options.psm);
    const flags = libc.symbols.fcntl(fd, F_GETFL, 0);
    libc.symbols.fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    const describe = (code: number) => `Could not open the band's L2CAP channel (PSM ${options.psm}): ${errnoMessage(code)}`;
    if (libc.symbols.connect(fd, ptr(remote), remote.length) < 0) {
      const code = errno();
      if (code !== EINPROGRESS) throw new Error(describe(code));
      const entries = [{ fd, events: POLLOUT }, ...(wakeFd !== undefined ? [{ fd: wakeFd, events: POLLIN }] : [])];
      const { buffer, revents } = pollfds(entries);
      const started = Date.now();
      for (;;) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new Error(`Could not open the band's L2CAP channel (PSM ${options.psm}): timed out`);
        const ready = libc.symbols.poll(ptr(buffer), BigInt(entries.length), remaining);
        if (ready < 0 && errno() === EINTR) continue;
        if (ready < 0) throw new Error(`poll failed while connecting: ${errnoMessage()}`);
        if (wakeFd !== undefined && revents(1) & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) throw new L2capCancelled();
        if (revents(0) & (POLLOUT | POLLERR | POLLHUP)) break;
      }
      const status = new Int32Array(1);
      const length = new Uint32Array([4]);
      if (libc.symbols.getsockopt(fd, SOL_SOCKET, SO_ERROR, ptr(status), ptr(length)) < 0) {
        throw new Error(`getsockopt failed after connect: ${errnoMessage()}`);
      }
      if (status[0] !== 0) throw new Error(describe(status[0]!));
    }
    libc.symbols.fcntl(fd, F_SETFL, flags);
    options.log?.(`L2CAP MTU: send ${socketMtu(fd, BT_SNDMTU)}, receive ${socketMtu(fd, BT_RCVMTU)}`);
    return fd;
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
}

export function writeAll(fd: number, data: Uint8Array, maxSdu = Infinity): void {
  // SEQPACKET preserves message boundaries; one write is one SDU to the band.
  for (let offset = 0; offset < data.length; offset += maxSdu) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxSdu));
    const count = libc.symbols.write(fd, ptr(chunk), BigInt(chunk.length));
    if (Number(count) !== chunk.length) {
      throw new Error(`Could not write to the band: ${Number(count) < 0 ? errnoMessage() : "short write"}`);
    }
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
  | { type: "opened"; fd: number; sendMtu: number }
  | { type: "log"; message: string }
  | { type: "data"; bytes: ArrayBuffer }
  | { type: "closed"; reason?: string }
  | { type: "error"; message: string };

/// Owns the socket lifetime. `onData` is called on the main thread with each received SDU.
export class L2capChannel {
  private worker: Worker | undefined;
  private fd = -1;
  private wake: [number, number] | undefined;
  private closed = false;
  private finished = false;

  constructor(
    private readonly handlers: {
      onOpen: () => void;
      onData: (bytes: Uint8Array) => void;
      onClose: (reason?: string) => void;
      onLog?: (message: string) => void;
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
      if (this.finished) return; // a late message from a worker that was already torn down
      const message = event.data;
      switch (message.type) {
        case "opened":
          this.fd = message.fd;
          this.sendMtu = message.sendMtu > 0 ? message.sendMtu : Infinity;
          this.handlers.onOpen();
          break;
        case "log":
          this.handlers.onLog?.(message.message);
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

  /// The peer's MTU once connected; frames larger than this are split across SDUs.
  sendMtu = Infinity;

  write(data: Uint8Array): void {
    if (this.closed || this.fd < 0 || data.length === 0) return;
    writeAll(this.fd, data, this.sendMtu);
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
    if (this.finished) return;
    this.finished = true;
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
