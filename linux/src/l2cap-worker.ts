// Blocking L2CAP reader. Polls the socket and a wake pipe; the main thread writes a
// byte to the pipe to ask for shutdown. Each received SDU is posted to the main thread.

import { ptr } from "bun:ffi";
import {
  BT_SNDMTU, L2capCancelled, POLLERR, POLLHUP, POLLIN, POLLNVAL, type WorkerCommand, type WorkerMessage,
  errno as ffiErrno, errnoMessage, libc, openL2cap, socketMtu,
} from "./l2cap";

declare const self: Worker;

const EINTR = 4;

function post(message: WorkerMessage, transfer: ArrayBuffer[] = []): void {
  self.postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  let fd = -1;
  if (command.type === "adopt") {
    fd = command.fd;
  } else {
    try {
      fd = openL2cap({ ...command.options, log: (message) => post({ type: "log", message }) }, command.wakeFd);
    } catch (error) {
      if (error instanceof L2capCancelled) post({ type: "closed" });
      else post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  post({ type: "opened", fd, sendMtu: command.type === "open" ? socketMtu(fd, BT_SNDMTU) : -1 });
  const fds = new Uint8Array(16);
  const view = new DataView(fds.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, POLLIN, true);
  view.setInt32(8, command.wakeFd, true);
  view.setInt16(12, POLLIN, true);
  const buffer = new Uint8Array(65_536);
  let reason: string | undefined;
  // Read-rate telemetry: SDUs and bytes per 2 s window, and the largest single read. A read that
  // returns a big backlog means the reader fell behind (a credit-starvation risk for LE CoC).
  let sdus = 0, bytes = 0, largest = 0, windowStart = Date.now();
  for (;;) {
    view.setInt16(6, 0, true);
    view.setInt16(14, 0, true);
    const ready = libc.symbols.poll(ptr(fds), 2n, 2000);
    const elapsed = Date.now() - windowStart;
    if (elapsed >= 2000) {
      if (sdus > 0) post({ type: "log", message: `rx ${sdus} sdus / ${bytes} B in ${elapsed} ms (largest read ${largest} B)` });
      sdus = 0; bytes = 0; largest = 0; windowStart = Date.now();
    }
    if (ready === 0) continue;
    if (ready < 0) {
      const code = ffiErrno();
      if (code === EINTR) continue;
      reason = `poll failed: ${errnoMessage(code)}`;
      break;
    }
    const wakeEvents = view.getInt16(14, true);
    if (wakeEvents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) break; // shutdown requested
    const socketEvents = view.getInt16(6, true);
    if (socketEvents & POLLIN) {
      const count = Number(libc.symbols.read(fd, ptr(buffer), BigInt(buffer.length)));
      if (count === 0) { reason = "The band input stream ended"; break; }
      if (count < 0) {
        const code = ffiErrno();
        if (code === EINTR) continue;
        reason = `Could not read band input: ${errnoMessage(code)}`;
        break;
      }
      sdus += 1; bytes += count; if (count > largest) largest = count;
      const copy = buffer.slice(0, count);
      post({ type: "data", bytes: copy.buffer }, [copy.buffer]);
    } else if (socketEvents & (POLLHUP | POLLERR)) {
      const err = new Int32Array(1); const elen = new Uint32Array([4]);
      libc.symbols.getsockopt(fd, 1 /* SOL_SOCKET */, 4 /* SO_ERROR */, ptr(err), ptr(elen));
      reason = `The band input stream failed (socket error ${err[0]}: ${errnoMessage(err[0]!)})`;
      break;
    }
  }
  libc.symbols.shutdown(fd, 2);
  libc.symbols.close(fd);
  post({ type: "closed", ...(reason !== undefined ? { reason } : {}) });
};
