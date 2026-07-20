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
} as const;

function envDefaults(): PartialConfig {
  const socket_dir = process.env.TXD_DB_SOCKET_DIR;
  const database = process.env.TXD_DB_DATABASE;
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

  return cfg as DaemonConfig;
}

export async function loadConfig(path = process.env.TXD_CONFIG): Promise<DaemonConfig> {
  if (!path) return assertConfig({});
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`txd config error: missing config file ${path}`);
  return assertConfig(await file.json());
}
