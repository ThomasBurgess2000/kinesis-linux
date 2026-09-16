import { expect, test } from "bun:test";
import { FFIType, dlopen, ptr } from "bun:ffi";
import { AF_BLUETOOTH, BDADDR_LE_RANDOM, L2capChannel, libc, sockaddrL2, writeAll } from "../src/l2cap";

const extra = dlopen("libc.so.6", {
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});
const AF_UNIX = 1, SOCK_SEQPACKET = 5;

test("sockaddr_l2 encodes the address reversed with little-endian psm and the address type", () => {
  const addr = sockaddrL2("C8:58:C0:A7:1A:E7", BDADDR_LE_RANDOM, 255);
  expect(addr.length).toBe(14);
  expect(new DataView(addr.buffer).getUint16(0, true)).toBe(AF_BLUETOOTH);
  expect([addr[2], addr[3]]).toEqual([255, 0]);
  expect(Array.from(addr.subarray(4, 10))).toEqual([0xe7, 0x1a, 0xa7, 0xc0, 0x58, 0xc8]);
  expect([addr[10], addr[11]]).toEqual([0, 0]);
  expect(addr[12]).toBe(BDADDR_LE_RANDOM);
  expect(() => sockaddrL2("not-an-address", BDADDR_LE_RANDOM, 255)).toThrow();
});

test("the worker delivers packets from a seqpacket peer and shuts down through the wake pipe", async () => {
  const fds = new Int32Array(2);
  expect(extra.symbols.socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ptr(fds))).toBe(0);
  const [workerEnd, peerEnd] = [fds[0]!, fds[1]!];
  const received: Uint8Array[] = [];
  let opened = false;
  let closeReason: string | undefined | null = null;
  const closed = new Promise<void>((resolve) => {
    const channel = new L2capChannel({
      onOpen: () => { opened = true; },
      onData: (bytes) => {
        received.push(bytes);
        if (received.length === 1) writeAll(peerEnd, new Uint8Array([9, 8, 7]));
        if (received.length === 2) channel.close();
      },
      onClose: (reason) => { closeReason = reason; resolve(); },
    });
    channel.adopt(workerEnd);
    // Give the worker a moment to start polling, then send the first packet.
    setTimeout(() => writeAll(peerEnd, new Uint8Array([1, 2, 3, 4])), 100);
  });
  await Promise.race([closed, Bun.sleep(5000).then(() => { throw new Error("worker did not close"); })]);
  expect(opened).toBe(true);
  expect(received.map((r) => Array.from(r))).toEqual([[1, 2, 3, 4], [9, 8, 7]]);
  expect(closeReason).toBeUndefined();
  libc.symbols.close(peerEnd);
});

test("a peer hang-up is reported as a stream end", async () => {
  const fds = new Int32Array(2);
  expect(extra.symbols.socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ptr(fds))).toBe(0);
  const [workerEnd, peerEnd] = [fds[0]!, fds[1]!];
  const reason = await new Promise<string | undefined>((resolve) => {
    const channel = new L2capChannel({
      onOpen: () => libc.symbols.close(peerEnd),
      onData: () => {},
      onClose: resolve,
    });
    channel.adopt(workerEnd);
  });
  expect(reason).toBe("The band input stream ended");
});
