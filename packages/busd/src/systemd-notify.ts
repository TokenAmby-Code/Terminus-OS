// sd_notify(3) for the Bun runtime.
//
// systemd's readiness protocol is a datagram written to the AF_UNIX socket
// named by $NOTIFY_SOCKET. Neither Node nor Bun exposes it, so socket(2) and
// sendto(2) come straight from libc through bun:ffi. Forking systemd-notify(1)
// would work on the wire but the signal would carry the helper's identity, and
// NotifyAccess=main accepts only the main process — so the daemon writes it
// itself.

import { dlopen, FFIType, ptr } from 'bun:ffi';

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0o2000000;
// sizeof(struct sockaddr_un.sun_path). The kernel refuses longer names, so the
// bound is the structure's, not a number of ours.
const SUN_PATH_MAX = 108;

type Libc = ReturnType<typeof openLibc>;
let libc: Libc | undefined;

function openLibc() {
  return dlopen('libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    sendto: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i64,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
}

/**
 * Announce that the daemon is up and serving.
 *
 * Under Type=notify this write is what completes the unit's start job, so
 * `systemctl start|restart` returns on the daemon's own listen edge rather than
 * on fork. Callers of that restart consume the return as proof of readiness;
 * this is the fact that makes them right.
 *
 * Outside systemd $NOTIFY_SOCKET is unset and nothing is waiting, so the call
 * is a total no-op — the FFI is never even opened.
 */
export function notifyReady(): void {
  const target = process.env.NOTIFY_SOCKET;
  if (!target) return;

  // A leading '@' names the abstract namespace, whose address begins with NUL.
  const name = target.startsWith('@') ? `\0${target.slice(1)}` : target;
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > SUN_PATH_MAX - 1) {
    throw new Error(`sd_notify: NOTIFY_SOCKET exceeds sun_path: ${target}`);
  }

  // struct sockaddr_un { sa_family_t sun_family; char sun_path[108]; }
  const addr = new Uint8Array(2 + SUN_PATH_MAX);
  new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
  addr.set(nameBytes, 2);
  // An abstract name is exactly its bytes; a filesystem name carries its NUL.
  const addrlen = 2 + nameBytes.length + (name.startsWith('\0') ? 0 : 1);

  libc ??= openLibc();
  const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) throw new Error('sd_notify: socket(AF_UNIX, SOCK_DGRAM) failed');
  try {
    const message = new TextEncoder().encode('READY=1');
    const sent = Number(
      libc.symbols.sendto(fd, ptr(message), BigInt(message.length), 0, ptr(addr), addrlen),
    );
    // Failing loud here costs the start job immediately and names the cause in
    // the journal. Swallowing it would instead spend systemd's start ceiling in
    // silence and then kill the bus with nothing to read — a hang with no root
    // cause, which is the worse of the two outcomes, not the safer one.
    if (sent !== message.length) {
      throw new Error(`sd_notify: sendto(${target}) wrote ${sent} of ${message.length} bytes`);
    }
  } finally {
    libc.symbols.close(fd);
  }
}
