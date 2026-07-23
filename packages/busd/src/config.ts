// Daemon configuration (B1 config pattern — no hardcoded machine values).
//
// Every machine-specific value is env/config-driven. A JSON file pointed at by
// BUSD_CONFIG wins; otherwise env vars, otherwise the localhost-safe defaults
// below. `machine` has NO default — it must come from config or
// IMPERIUM_MACHINE (fail loud if the box identity is unknown; a daemon that
// guesses its own machine is a bug).

import { DbEndpoint, type DbEndpointT } from '@terminus-os/db';

export type DaemonConfig = {
  bind: string;
  port: number;
  machine: string;
  /** Postgres endpoint for the bus journal (peer-auth unix socket on fleet boxes). */
  db: DbEndpointT;
  /** Fallback dispatch tick: repairs out-of-band inserts and revived subscribers. */
  repairIntervalMs: number;
  /** Per-delivery HTTP timeout. */
  deliveryTimeoutMs: number;
  /** Journal rows read per delivery batch. */
  batchSize: number;
  /** Full-jitter exponential backoff: base and cap. */
  backoffBaseMs: number;
  backoffCapMs: number;
};

// Partial with explicit undefined: the root tsconfig pins
// `exactOptionalPropertyTypes`, and these maps deliberately carry `undefined`
// for "not provided at this layer" (resolved by the ?? chains below).
type PartialConfig = { [K in keyof DaemonConfig]?: DaemonConfig[K] | undefined };

const HARD_DEFAULTS = {
  bind: '127.0.0.1',
  port: 7782,
  // Fleet-standard Postgres 18 endpoint: the native cluster's peer-auth unix
  // socket, terminus database. Peer auth is the contract — no credential
  // exists anywhere in config.
  db: DbEndpoint.parse({
    kind: 'socket',
    socket_dir: '/var/run/postgresql',
    database: 'terminus',
    application_name: 'busd',
  }),
  repairIntervalMs: 30_000,
  deliveryTimeoutMs: 10_000,
  batchSize: 100,
  backoffBaseMs: 500,
  backoffCapMs: 60_000,
} as const;

function envDefaults(): PartialConfig {
  const socket_dir = process.env.BUSD_DB_SOCKET_DIR;
  const database = process.env.BUSD_DB_DATABASE;
  return {
    bind: process.env.BUSD_BIND,
    port: process.env.BUSD_PORT ? Number(process.env.BUSD_PORT) : undefined,
    machine: process.env.IMPERIUM_MACHINE,
    db:
      socket_dir || database
        ? DbEndpoint.parse({
            ...HARD_DEFAULTS.db,
            ...(socket_dir ? { socket_dir } : {}),
            ...(database ? { database } : {}),
          })
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
    repairIntervalMs: raw.repairIntervalMs ?? HARD_DEFAULTS.repairIntervalMs,
    deliveryTimeoutMs: raw.deliveryTimeoutMs ?? HARD_DEFAULTS.deliveryTimeoutMs,
    batchSize: raw.batchSize ?? HARD_DEFAULTS.batchSize,
    backoffBaseMs: raw.backoffBaseMs ?? HARD_DEFAULTS.backoffBaseMs,
    backoffCapMs: raw.backoffCapMs ?? HARD_DEFAULTS.backoffCapMs,
  };

  if (!cfg.bind) throw new Error('busd config error: bind is required');
  if (!Number.isInteger(cfg.port) || cfg.port! < 1 || cfg.port! > 65535)
    throw new Error(`busd config error: invalid port ${cfg.port}`);
  if (!cfg.machine)
    throw new Error('busd config error: machine is required (set IMPERIUM_MACHINE or config.machine — the daemon must never guess its box identity)');
  // Strict endpoint validation: unknown fields inside `db` are rejected loud.
  const db = DbEndpoint.safeParse(cfg.db);
  if (!db.success)
    throw new Error(`busd config error: invalid db endpoint — ${db.error.message}`);
  cfg.db = db.data;
  for (const knob of ['repairIntervalMs', 'deliveryTimeoutMs', 'batchSize', 'backoffBaseMs', 'backoffCapMs'] as const) {
    if (!Number.isInteger(cfg[knob]) || cfg[knob]! < 1)
      throw new Error(`busd config error: ${knob} must be a positive integer (got ${cfg[knob]})`);
  }
  if (cfg.backoffCapMs! < cfg.backoffBaseMs!)
    throw new Error('busd config error: backoffCapMs must be >= backoffBaseMs');

  return cfg as DaemonConfig;
}

export async function loadConfig(path = process.env.BUSD_CONFIG): Promise<DaemonConfig> {
  if (!path) return assertConfig({});
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`busd config error: missing config file ${path}`);
  return assertConfig(await file.json());
}
