// Daemon configuration (B1 config pattern — no hardcoded machine values).
//
// Every machine-specific value (machine identity, sockets, database endpoint,
// port, bind) is env/config-driven. A JSON file pointed at by TXD_CONFIG wins;
// otherwise env vars, otherwise the localhost-safe defaults below. `machine`
// has NO default — it must come from config or IMPERIUM_MACHINE (fail loud if
// the box identity is unknown; a daemon that guesses its own machine is a bug).

import { DbEndpoint, type DbEndpointT } from '@terminus-os/db';

export type DaemonConfig = {
  bind: string;
  port: number;
  machine: string;
  /** Postgres endpoint for the event stream (peer-auth unix socket on fleet boxes). */
  db: DbEndpointT;
  /** The tmux socket name (`tmux -L <name>`) this daemon owns authoritatively. */
  tmuxSocket: string;
  /** Kernel lock held across an estate rotation until reconstruction completes. */
  rotationLockFile: string;
  /** Private handoff FIFO between the retiring and reconstructed daemon generations. */
  rotationSignalFifo: string;
  /** Sanctioned Fleet wrapper executable. Identity remains compiled into txd. */
  agentWrapper: string;
  /**
   * lifecycled's local ingress socket, for arming the pre-send comm watch.
   * Empty string disables the watch plane (degrades loudly per comm).
   */
  lifecycledSocket: string;
  /**
   * Bound on the arm await. Mirrors lifecycled's delivery contract; change
   * them together.
   */
  commWatchTimeoutMs: number;
  /** Generated physical-only view of Token-Fleet's canonical pane allocation. */
  physicalRegistration?: {
    generation: string;
    digest: string;
    perpetual: Record<string, 'claude' | 'codex'>;
    commStreams?: Record<string, 'interactive' | 'headless'>;
  };
};

// Partial with explicit undefined: the root tsconfig pins
// `exactOptionalPropertyTypes`, and these maps deliberately carry `undefined`
// for "not provided at this layer" (resolved by the ?? chains below).
type PartialConfig = { [K in keyof DaemonConfig]?: DaemonConfig[K] | undefined };

const HARD_DEFAULTS = {
  bind: '127.0.0.1',
  port: 7781,
  // Fleet-standard Postgres 18 endpoint: the native cluster's peer-auth unix
  // socket, terminus database. Peer auth is the contract — no credential
  // exists anywhere in config.
  db: DbEndpoint.parse({
    kind: 'socket',
    socket_dir: '/var/run/postgresql',
    database: 'terminus',
    application_name: 'txd',
  }),
  tmuxSocket: 'k12',
  lifecycledSocket: `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/lifecycled/ingress.sock`,
  commWatchTimeoutMs: 5 * 60 * 1000,
  rotationLockFile: `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/txd/estate-rotation.lock`,
  rotationSignalFifo: `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/txd/estate-rotation.signal`,
} as const;

function envDefaults(): PartialConfig {
  const socket_dir = process.env.TXD_DB_SOCKET_DIR;
  const database = process.env.TXD_DB_DATABASE;
  const registrationRequired = {
    generation: process.env.TXD_REGISTRATION_CONFIG_GENERATION,
    digest: process.env.TXD_REGISTRATION_CONFIG_DIGEST,
  };
  let perpetual: Record<string, 'claude' | 'codex'> = {};
  let commStreams: Record<string, 'interactive' | 'headless'> = {};
  if (process.env.TXD_PERPETUAL_AGENTS !== undefined) {
    try {
      perpetual = JSON.parse(process.env.TXD_PERPETUAL_AGENTS) as Record<string, 'claude' | 'codex'>;
    } catch {
      throw new Error('txd config error: TXD_PERPETUAL_AGENTS must be valid JSON');
    }
  }
  if (process.env.TXD_COMM_STREAM_CLASSES !== undefined) {
    try {
      commStreams = JSON.parse(process.env.TXD_COMM_STREAM_CLASSES) as Record<string, 'interactive' | 'headless'>;
    } catch {
      throw new Error('txd config error: TXD_COMM_STREAM_CLASSES must be valid JSON');
    }
  }
  const registrationSeen = Object.values(registrationRequired).some((value) => value !== undefined);
  if (registrationSeen && Object.values(registrationRequired).some((value) => !value)) {
    throw new Error('txd config error: physical registration environment is incomplete');
  }
  const registration = { ...registrationRequired, perpetual, commStreams };
  return {
    bind: process.env.TXD_BIND,
    port: process.env.TXD_PORT ? Number(process.env.TXD_PORT) : undefined,
    machine: process.env.IMPERIUM_MACHINE,
    db:
      socket_dir || database
        ? DbEndpoint.parse({
            ...HARD_DEFAULTS.db,
            ...(socket_dir ? { socket_dir } : {}),
            ...(database ? { database } : {}),
          })
        : undefined,
    tmuxSocket: process.env.TXD_TMUX_SOCKET,
    lifecycledSocket: process.env.TXD_LIFECYCLED_SOCKET,
    commWatchTimeoutMs: process.env.TXD_COMM_WATCH_TIMEOUT_MS ? Number(process.env.TXD_COMM_WATCH_TIMEOUT_MS) : undefined,
    rotationLockFile: process.env.TXD_ROTATION_LOCK_FILE,
    rotationSignalFifo: process.env.TXD_ROTATION_SIGNAL_FIFO,
    agentWrapper: process.env.TXD_AGENT_WRAPPER,
    physicalRegistration: registrationSeen
      ? registration as DaemonConfig['physicalRegistration']
      : undefined,
  };
}

export function assertConfig(raw: PartialConfig): DaemonConfig {
  const env = envDefaults();
  const cfg: PartialConfig = {
    bind: raw.bind ?? env.bind ?? HARD_DEFAULTS.bind,
    port: raw.port ?? env.port ?? HARD_DEFAULTS.port,
    machine: raw.machine ?? env.machine, // NO hard default — must be known
    db: raw.db ?? env.db ?? HARD_DEFAULTS.db,
    tmuxSocket: raw.tmuxSocket ?? env.tmuxSocket ?? HARD_DEFAULTS.tmuxSocket,
    lifecycledSocket: raw.lifecycledSocket ?? env.lifecycledSocket ?? HARD_DEFAULTS.lifecycledSocket,
    commWatchTimeoutMs: raw.commWatchTimeoutMs ?? env.commWatchTimeoutMs ?? HARD_DEFAULTS.commWatchTimeoutMs,
    rotationLockFile: raw.rotationLockFile ?? env.rotationLockFile ?? HARD_DEFAULTS.rotationLockFile,
    rotationSignalFifo: raw.rotationSignalFifo ?? env.rotationSignalFifo ?? HARD_DEFAULTS.rotationSignalFifo,
    agentWrapper: raw.agentWrapper ?? env.agentWrapper,
    physicalRegistration: raw.physicalRegistration ?? env.physicalRegistration,
  };

  if (!cfg.bind) throw new Error('txd config error: bind is required');
  if (!Number.isInteger(cfg.port) || cfg.port! < 1 || cfg.port! > 65535)
    throw new Error(`txd config error: invalid port ${cfg.port}`);
  if (!cfg.machine)
    throw new Error('txd config error: machine is required (set IMPERIUM_MACHINE or config.machine — the daemon must never guess its box identity)');
  // Strict endpoint validation: unknown fields inside `db` are rejected loud.
  const db = DbEndpoint.safeParse(cfg.db);
  if (!db.success)
    throw new Error(`txd config error: invalid db endpoint — ${db.error.message}`);
  cfg.db = db.data;
  if (!cfg.tmuxSocket) throw new Error('txd config error: tmuxSocket is required');
  if (cfg.lifecycledSocket === undefined) throw new Error('txd config error: lifecycledSocket is required (empty string disables the comm watch plane)');
  if (!Number.isInteger(cfg.commWatchTimeoutMs) || cfg.commWatchTimeoutMs! < 5 * 60 * 1000)
    throw new Error(`txd config error: invalid commWatchTimeoutMs ${cfg.commWatchTimeoutMs}`);
  if (!cfg.rotationLockFile) throw new Error('txd config error: rotationLockFile is required');
  if (!cfg.rotationSignalFifo) throw new Error('txd config error: rotationSignalFifo is required');
  if (!cfg.agentWrapper) throw new Error('txd config error: agentWrapper is required');
  if (cfg.physicalRegistration !== undefined) {
    const physical = cfg.physicalRegistration as DaemonConfig['physicalRegistration'];
    if (!physical?.generation) {
      throw new Error('txd config error: physicalRegistration.generation is required');
    }
    if (!/^[0-9a-f]{64}$/.test(physical.digest)) {
      throw new Error('txd config error: physicalRegistration.digest must be a sha256 hex digest');
    }
    if (!physical.perpetual || typeof physical.perpetual !== 'object'
        || Array.isArray(physical.perpetual)
        || Object.entries(physical.perpetual).some(([pane, engine]) =>
          !pane || (engine !== 'claude' && engine !== 'codex'))) {
      throw new Error('txd config error: physicalRegistration.perpetual must map panes to engines');
    }
    if (physical.commStreams !== undefined && (typeof physical.commStreams !== 'object'
        || Array.isArray(physical.commStreams)
        || Object.entries(physical.commStreams).some(([pane, stream]) =>
          !pane || (stream !== 'interactive' && stream !== 'headless')))) {
      throw new Error('txd config error: physicalRegistration.commStreams must map panes to stream classes');
    }
  }

  return cfg as DaemonConfig;
}

export async function loadConfig(path = process.env.TXD_CONFIG): Promise<DaemonConfig> {
  if (!path) return assertConfig({});
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`txd config error: missing config file ${path}`);
  return assertConfig(await file.json());
}
