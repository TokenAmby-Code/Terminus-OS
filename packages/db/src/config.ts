import { z } from "zod";

/**
 * Where a consumer sits relative to the database.
 * `remote` → the native `18/main` production cluster on k12-personal.
 * `local`  → the disposable rootless-podman dev container.
 * Both earmarks exist in every config surface even where their values coincide.
 */
export const DB_EARMARKS = ["remote", "local"] as const;
export const DbEarmark = z.enum(DB_EARMARKS);
export type DbEarmarkT = z.infer<typeof DbEarmark>;

/**
 * Unix-socket endpoint — the only sanctioned shape on fleet machines.
 * Peer auth over the socket is the contract: no password field exists,
 * and the strict schema rejects one outright.
 */
export const SocketEndpoint = z.strictObject({
  kind: z.literal("socket"),
  /** Directory holding the postmaster socket (`.s.PGSQL.<port>` lives inside it). */
  socket_dir: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  application_name: z.string().min(1),
});
export type SocketEndpointT = z.infer<typeof SocketEndpoint>;

/**
 * TCP endpoint — sanctioned ONLY for CI, which reaches a `postgres:18`
 * service container over localhost (trust auth; still no password field).
 */
export const TcpEndpoint = z.strictObject({
  kind: z.literal("tcp"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  username: z.string().min(1),
  application_name: z.string().min(1),
});
export type TcpEndpointT = z.infer<typeof TcpEndpoint>;

export const DbEndpoint = z.discriminatedUnion("kind", [SocketEndpoint, TcpEndpoint]);
export type DbEndpointT = z.infer<typeof DbEndpoint>;

/** One endpoint per earmark. Parse once at process start; pass the object around. */
export const DbConfig = z.strictObject({
  remote: DbEndpoint,
  local: DbEndpoint,
});
export type DbConfigT = z.infer<typeof DbConfig>;

export function parseDbConfig(input: unknown): DbConfigT {
  return DbConfig.parse(input);
}

export function resolveEndpoint(config: DbConfigT, earmark: DbEarmarkT): DbEndpointT {
  return config[earmark];
}

/**
 * Canonical fleet defaults. Values coincide today (both earmarks answer on the
 * standard socket dir); the earmark split is the contract, not the divergence.
 */
export const DEFAULT_DB_CONFIG: DbConfigT = DbConfig.parse({
  remote: {
    kind: "socket",
    socket_dir: "/var/run/postgresql",
    database: "terminus",
    application_name: "terminus-os",
  },
  local: {
    kind: "socket",
    socket_dir: "/var/run/postgresql",
    database: "terminus",
    application_name: "terminus-os",
  },
});

/** Stable one-line identity for logs and fail-loud error messages. */
export function describeEndpoint(endpoint: DbEndpointT): string {
  return endpoint.kind === "socket"
    ? `socket ${endpoint.socket_dir}/.s.PGSQL.${endpoint.port} db=${endpoint.database}`
    : `tcp ${endpoint.host}:${endpoint.port} db=${endpoint.database} user=${endpoint.username}`;
}
