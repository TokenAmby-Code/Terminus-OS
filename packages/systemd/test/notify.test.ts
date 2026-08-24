// sd_notify readiness — behavioral-pin lane.
//
// The readiness datagram is deploy-critical: under Type=notify it is the write
// that completes a daemon's start job, so `systemctl restart <unit>` returns on
// that daemon's serving edge instead of on fork. If it never arrives systemd
// holds the start job to its own ceiling and then kills the daemon, so these
// pins assert the wire bytes and the address encoding rather than trusting the
// syscall wrapper.
//
// The receiver here binds and reads with the same libc primitives from the
// other side (bind/recvfrom against the module's socket/sendto), so a pass is
// an end-to-end datagram, not a mock.

import { afterEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { notifyReady } from '../src/index.ts';

const AF_UNIX = 1;
const SOCK_DGRAM = 2;

const libc = dlopen('libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

/** struct sockaddr_un for `name`, plus the addrlen the kernel expects. */
function sockaddrUn(name: string): { addr: Uint8Array; length: number } {
  const bytes = new TextEncoder().encode(name);
  const addr = new Uint8Array(110);
  new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
  addr.set(bytes, 2);
  // Abstract names (leading NUL) are exactly their byte length; filesystem
  // names carry their terminator.
  return { addr, length: 2 + bytes.length + (name.startsWith('\0') ? 0 : 1) };
}

/** Bind a datagram socket at `name` and return a one-shot reader. */
function receiver(name: string): { read: () => string; close: () => void } {
  const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM, 0);
  expect(fd).toBeGreaterThanOrEqual(0);
  const { addr, length } = sockaddrUn(name);
  expect(libc.symbols.bind(fd, ptr(addr), length)).toBe(0);
  return {
    // The sender writes before this runs, so the datagram is already queued and
    // the blocking read returns without waiting. No timeout is invented here.
    read() {
      const buffer = new Uint8Array(256);
      const read = Number(libc.symbols.recv(fd, ptr(buffer), BigInt(buffer.length), 0));
      expect(read).toBeGreaterThan(0);
      return new TextDecoder().decode(buffer.subarray(0, read));
    },
    close: () => void libc.symbols.close(fd),
  };
}

const priorSocket = process.env.NOTIFY_SOCKET;
afterEach(() => {
  if (priorSocket === undefined) delete process.env.NOTIFY_SOCKET;
  else process.env.NOTIFY_SOCKET = priorSocket;
});

describe('notifyReady', () => {
  test('writes READY=1 to a filesystem NOTIFY_SOCKET', () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminus-notify-'));
    const path = join(dir, 'notify');
    const socket = receiver(path);
    try {
      process.env.NOTIFY_SOCKET = path;
      notifyReady();
      expect(socket.read()).toBe('READY=1');
    } finally {
      socket.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes READY=1 to an abstract NOTIFY_SOCKET', () => {
    const name = `terminus-notify-${process.pid}`;
    const socket = receiver(`\0${name}`);
    try {
      process.env.NOTIFY_SOCKET = `@${name}`;
      notifyReady();
      expect(socket.read()).toBe('READY=1');
    } finally {
      socket.close();
    }
  });

  test('no NOTIFY_SOCKET is a silent no-op — a daemon outside systemd runs unchanged', () => {
    delete process.env.NOTIFY_SOCKET;
    expect(() => notifyReady()).not.toThrow();
  });

  test('an unreachable NOTIFY_SOCKET fails loud rather than silently succeeding', () => {
    // A swallowed failure here becomes a systemd start-job hang with no cause in
    // the journal: the silent-intermittent shape the polls doctrine forbids.
    process.env.NOTIFY_SOCKET = join(tmpdir(), `terminus-notify-absent-${process.pid}`);
    expect(() => notifyReady()).toThrow(/sd_notify/);
  });

  test('an over-long NOTIFY_SOCKET is refused before the syscall', () => {
    process.env.NOTIFY_SOCKET = `/${'x'.repeat(120)}`;
    expect(() => notifyReady()).toThrow(/sd_notify/);
  });
});
