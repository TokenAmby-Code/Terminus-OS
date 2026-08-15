import { createConnection, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION_3 = 196608;
const CHANNEL = "journal_events";

export type ListenerState = "stopped" | "connecting" | "authenticating" | "registering" | "listening" | "backoff" | "failed";
export type ListenerEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number; serverName: string; ca: string | Buffer };

export type ListenerHealth = {
  state: ListenerState;
  generation: number;
  registeredAt: string | null;
  lastNotificationAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorCode: string | null;
  reconnectCount: number;
  nextAttemptAt: string | null;
  catchUpPending: boolean;
  catchUpRunning: boolean;
};

export type PgNotificationListenerOptions = {
  endpoint: ListenerEndpoint;
  user: string;
  database: string;
  applicationName: string;
  password?: string;
  maxFrameBytes: number;
  reconnectDelayMs: (failure: { attempt: number; code: string }) => number | null;
  onDrainRequested: () => Promise<void>;
};

export class PgProtocolError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "PgProtocolError";
  }
}

type Frame = { type: string; body: Buffer };
type WireSocket = Socket | TLSSocket;

class FrameParser {
  #buffer = Buffer.alloc(0);
  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readInt32BE(1);
      if (length < 4) throw new PgProtocolError("invalid_frame_length");
      if (length > this.maxFrameBytes) throw new PgProtocolError("oversized_frame");
      if (this.#buffer.length < length + 1) break;
      frames.push({ type: String.fromCharCode(this.#buffer[0]!), body: this.#buffer.subarray(5, length + 1) });
      this.#buffer = this.#buffer.subarray(length + 1);
    }
    return frames;
  }
}

class FrameQueue {
  #frames: Frame[] = [];
  #waiters: Array<{ resolve: (frame: Frame) => void; reject: (error: unknown) => void }> = [];
  #error: unknown;

  push(frame: Frame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.#frames.push(frame);
  }

  fail(error: unknown): void {
    if (this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<Frame> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  poll(): Frame | undefined { return this.#frames.shift(); }
}

const int32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

const message = (type: string, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);

const startup = (options: PgNotificationListenerOptions): Buffer => {
  const body = Buffer.from(
    `user\0${options.user}\0database\0${options.database}\0application_name\0${options.applicationName}\0\0`,
  );
  return Buffer.concat([int32(body.length + 8), int32(PROTOCOL_VERSION_3), body]);
};

const cstring = (body: Buffer, offset: number): { value: string; next: number } => {
  const end = body.indexOf(0, offset);
  if (end < 0) throw new PgProtocolError("unterminated_cstring");
  return { value: body.subarray(offset, end).toString("utf8"), next: end + 1 };
};

const errorFields = (body: Buffer): Map<string, string> => {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const tag = String.fromCharCode(body[offset++]!);
    const field = cstring(body, offset);
    fields.set(tag, field.value);
    offset = field.next;
  }
  return fields;
};

const scramAttributes = (messageText: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const part of messageText.split(",")) {
    if (part.length < 3 || part[1] !== "=" || attributes.has(part[0]!)) {
      throw new PgProtocolError("invalid_scram_message");
    }
    attributes.set(part[0]!, part.slice(2));
  }
  if (attributes.has("m")) throw new PgProtocolError("unsupported_scram_extension");
  return attributes;
};

const canonicalBase64 = (value: string, code: string): Buffer => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new PgProtocolError(code);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) throw new PgProtocolError(code);
  return decoded;
};

export class ScramSha256Client {
  readonly clientNonce: string;
  readonly clientFirstBare: string;
  readonly clientFirst: string;
  #expectedServerSignature: Buffer | undefined;

  constructor(user: string, private readonly password: string, nonce?: string) {
    this.clientNonce = nonce ?? randomBytes(24).toString("base64url");
    if (!/^[A-Za-z0-9+/_=-]+$/.test(this.clientNonce) || this.clientNonce.includes(",")) {
      throw new PgProtocolError("invalid_scram_client_nonce");
    }
    const escapedUser = user.replaceAll("=", "=3D").replaceAll(",", "=2C");
    this.clientFirstBare = `n=${escapedUser},r=${this.clientNonce}`;
    this.clientFirst = `n,,${this.clientFirstBare}`;
  }

  continue(serverFirst: string): string {
    const fields = scramAttributes(serverFirst);
    const nonce = fields.get("r");
    const saltText = fields.get("s");
    const iterations = Number(fields.get("i"));
    if (!nonce?.startsWith(this.clientNonce) || nonce === this.clientNonce) throw new PgProtocolError("invalid_scram_nonce");
    if (!saltText || !Number.isSafeInteger(iterations) || iterations < 4096) throw new PgProtocolError("invalid_scram_parameters");
    const salt = canonicalBase64(saltText, "invalid_scram_salt");
    const saltedPassword = pbkdf2Sync(this.password, salt, iterations, 32, "sha256");
    const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();
    const finalWithoutProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${finalWithoutProof}`;
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    const proof = Buffer.alloc(clientKey.length);
    for (let index = 0; index < proof.length; index += 1) proof[index] = clientKey[index]! ^ clientSignature[index]!;
    const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
    this.#expectedServerSignature = createHmac("sha256", serverKey).update(authMessage).digest();
    const encodedProof = proof.toString("base64");
    saltedPassword.fill(0);
    clientKey.fill(0);
    storedKey.fill(0);
    clientSignature.fill(0);
    proof.fill(0);
    serverKey.fill(0);
    return `${finalWithoutProof},p=${encodedProof}`;
  }

  finish(serverFinal: string): void {
    const fields = scramAttributes(serverFinal);
    if (fields.has("e") && fields.has("v")) throw new PgProtocolError("invalid_scram_message");
    if (fields.has("e")) throw new PgProtocolError("scram_server_error");
    const signature = fields.has("v")
      ? canonicalBase64(fields.get("v")!, "invalid_scram_server_signature")
      : Buffer.alloc(0);
    if (!this.#expectedServerSignature || signature.length !== this.#expectedServerSignature.length
      || !timingSafeEqual(signature, this.#expectedServerSignature)) {
      throw new PgProtocolError("invalid_scram_server_signature");
    }
    this.#expectedServerSignature.fill(0);
    this.#expectedServerSignature = undefined;
  }
}

const openSocket = (endpoint: ListenerEndpoint): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = endpoint.kind === "unix"
    ? createConnection({ path: endpoint.path })
    : createConnection({ host: endpoint.host, port: endpoint.port });
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
});

const readSslResponse = (socket: Socket): Promise<string> => new Promise((resolve, reject) => {
  const onData = (chunk: Buffer) => {
    cleanup();
    if (chunk.length !== 1) reject(new PgProtocolError("invalid_ssl_response"));
    else resolve(String.fromCharCode(chunk[0]!));
  };
  const onError = (error: Error) => { cleanup(); reject(error); };
  const onEnd = () => { cleanup(); reject(new PgProtocolError("unexpected_eof")); };
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("end", onEnd);
  };
  socket.once("data", onData);
  socket.once("error", onError);
  socket.once("end", onEnd);
});

const upgradeTls = (socket: Socket, endpoint: Extract<ListenerEndpoint, { kind: "tcp" }>): Promise<TLSSocket> =>
  new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername: endpoint.serverName, ca: endpoint.ca, rejectUnauthorized: true });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
  });

const protocolError = (frame: Frame): PgProtocolError => {
  const fields = errorFields(frame.body);
  return new PgProtocolError(`postgres_${fields.get("C") ?? "error"}`);
};

export class PgNotificationListener {
  #health: ListenerHealth = {
    state: "stopped", generation: 0, registeredAt: null, lastNotificationAt: null,
    lastDisconnectAt: null, lastErrorCode: null, reconnectCount: 0, nextAttemptAt: null,
    catchUpPending: false, catchUpRunning: false,
  };
  #running = false;
  #loop?: Promise<void>;
  #socket: WireSocket | undefined;
  #drainScheduled = false;
  #cancelBackoff: (() => void) | undefined;
  #registrationWaiters: Array<{ generation: number; resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(private readonly options: PgNotificationListenerOptions) {
    if (!options.user || !options.database || !options.applicationName) throw new Error("listener identity fields must be non-empty");
    if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 8) throw new Error("maxFrameBytes must be a declared positive frame ceiling");
  }

  health(): ListenerHealth { return { ...this.#health }; }

  async start(): Promise<void> {
    if (this.#running) throw new Error("listener already started");
    this.#running = true;
    this.#loop = this.#run();
  }

  registered(generation = 1): Promise<void> {
    if (this.#health.generation >= generation && this.#health.state === "listening") return Promise.resolve();
    return new Promise((resolve, reject) => this.#registrationWaiters.push({ generation, resolve, reject }));
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#cancelBackoff?.();
    this.#socket?.destroy();
    await this.#loop;
    this.#health = { ...this.#health, state: "stopped", nextAttemptAt: null };
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (this.#running) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (!this.#running) break;
        attempt += 1;
        const code = error instanceof PgProtocolError ? error.code : "connection_failed";
        this.#health = { ...this.#health, state: "failed", lastErrorCode: code, lastDisconnectAt: new Date().toISOString() };
        const delay = this.options.reconnectDelayMs({ attempt, code });
        if (delay === null) {
          for (const waiter of this.#registrationWaiters.splice(0)) waiter.reject(error);
          break;
        }
        if (!Number.isFinite(delay) || delay < 0) throw new Error("reconnectDelayMs returned an invalid delay");
        this.#health = {
          ...this.#health, state: "backoff", reconnectCount: this.#health.reconnectCount + 1,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.#cancelBackoff = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#cancelBackoff = undefined;
        this.#health.nextAttemptAt = null;
      }
    }
  }

  async connectOnce(): Promise<never> {
    try {
      return await this.#connectSession();
    } finally {
      this.#socket?.destroy();
      this.#socket = undefined;
    }
  }

  async #connectSession(): Promise<never> {
    this.#health = { ...this.#health, state: "connecting", lastErrorCode: null };
    let socket: WireSocket = await openSocket(this.options.endpoint);
    if (this.options.endpoint.kind === "tcp") {
      socket.write(Buffer.concat([int32(8), int32(SSL_REQUEST_CODE)]));
      if (await readSslResponse(socket) !== "S") {
        socket.destroy();
        throw new PgProtocolError("remote_plaintext_refused");
      }
      socket = await upgradeTls(socket, this.options.endpoint);
    }
    this.#socket = socket;
    const parser = new FrameParser(this.options.maxFrameBytes);
    const queue = new FrameQueue();
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const parsed of parser.push(chunk)) queue.push(parsed);
      } catch (error) {
        queue.fail(error);
        socket.destroy();
      }
    });
    socket.once("error", (error) => queue.fail(error));
    socket.once("end", () => queue.fail(new PgProtocolError("unexpected_eof")));
    socket.once("close", () => queue.fail(new PgProtocolError("connection_closed")));

    this.#health.state = "authenticating";
    socket.write(startup(this.options));
    let authenticated = false;
    let scram: ScramSha256Client | undefined;
    while (true) {
      const incoming = await queue.next();
      if (incoming.type === "E") throw protocolError(incoming);
      if (incoming.type === "R") {
        if (incoming.body.length < 4) throw new PgProtocolError("short_authentication_frame");
        const mode = incoming.body.readInt32BE(0);
        if (mode === 0) { authenticated = true; continue; }
        if (mode === 3) throw new PgProtocolError("cleartext_auth_refused");
        if (mode === 5) throw new PgProtocolError("md5_auth_refused");
        if (mode === 10) {
          if (!this.options.password) throw new PgProtocolError("scram_password_missing");
          const mechanisms = incoming.body.subarray(4).toString("utf8").split("\0").filter(Boolean);
          if (!mechanisms.includes("SCRAM-SHA-256")) throw new PgProtocolError("scram_sha_256_unavailable");
          scram = new ScramSha256Client(this.options.user, this.options.password);
          const initial = Buffer.from(scram.clientFirst);
          socket.write(message("p", Buffer.concat([Buffer.from("SCRAM-SHA-256\0"), int32(initial.length), initial])));
          continue;
        }
        if (mode === 11) {
          if (!scram) throw new PgProtocolError("unexpected_scram_continue");
          socket.write(message("p", Buffer.from(scram.continue(incoming.body.subarray(4).toString("utf8")))));
          continue;
        }
        if (mode === 12) {
          if (!scram) throw new PgProtocolError("unexpected_scram_final");
          scram.finish(incoming.body.subarray(4).toString("utf8"));
          continue;
        }
        throw new PgProtocolError("unsupported_authentication_mode");
      }
      if (incoming.type === "Z") {
        if (!authenticated) throw new PgProtocolError("ready_before_authentication");
        break;
      }
      if (!["S", "K", "N"].includes(incoming.type)) throw new PgProtocolError("unexpected_authentication_frame");
    }

    this.#health.state = "registering";
    socket.write(message("Q", Buffer.from(`LISTEN ${CHANNEL}\0`)));
    let completed = false;
    while (true) {
      const incoming = await queue.next();
      if (incoming.type === "E") throw protocolError(incoming);
      if (incoming.type === "C") {
        completed = cstring(incoming.body, 0).value === "LISTEN";
        if (!completed) throw new PgProtocolError("listen_command_not_completed");
      } else if (incoming.type === "Z") {
        if (!completed) throw new PgProtocolError("listen_ready_without_completion");
        break;
      } else if (!["N", "S", "K"].includes(incoming.type)) {
        throw new PgProtocolError("unexpected_listen_frame");
      }
    }

    const generation = this.#health.generation + 1;
    this.#health = { ...this.#health, state: "listening", generation, registeredAt: new Date().toISOString() };
    for (const waiter of this.#registrationWaiters.filter((item) => generation >= item.generation)) waiter.resolve();
    this.#registrationWaiters = this.#registrationWaiters.filter((item) => generation < item.generation);
    this.#requestDrain();

    let incoming = await queue.next();
    while (true) {
      if (incoming.type === "E") throw protocolError(incoming);
      if (incoming.type === "N") continue;
      if (incoming.type !== "A") throw new PgProtocolError("unexpected_listening_frame");
      if (incoming.body.length < 6) throw new PgProtocolError("short_notification_frame");
      const channel = cstring(incoming.body, 4);
      const payload = cstring(incoming.body, channel.next).value;
      if (channel.value !== CHANNEL) throw new PgProtocolError("unexpected_notification_channel");
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { throw new PgProtocolError("invalid_notification_payload"); }
      if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1
        || !Number.isSafeInteger((parsed as { high?: unknown }).high) || Number((parsed as { high: number }).high) < 1) {
        throw new PgProtocolError("invalid_notification_payload");
      }
      this.#health.lastNotificationAt = new Date().toISOString();
      this.#requestDrain();
      incoming = queue.poll() ?? await queue.next();
    }
  }

  #requestDrain(): void {
    this.#health.catchUpPending = true;
    if (this.#drainScheduled || this.#health.catchUpRunning) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      void this.#drain().catch(() => {
        this.#health.catchUpPending = true;
        this.#health.lastErrorCode = "drain_failed";
        this.#socket?.destroy(new PgProtocolError("drain_failed"));
      });
    });
  }

  async #drain(): Promise<void> {
    this.#drainScheduled = false;
    if (this.#health.catchUpRunning) return;
    this.#health.catchUpRunning = true;
    try {
      while (this.#health.catchUpPending) {
        this.#health.catchUpPending = false;
        await this.options.onDrainRequested();
      }
    } finally {
      this.#health.catchUpRunning = false;
      if (this.#health.catchUpPending) this.#requestDrain();
    }
  }
}
