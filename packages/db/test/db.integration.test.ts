import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { SQL } from "bun";
import { connectDb, typedRows } from "../src/client.ts";
import { DbEndpoint, type DbEndpointT } from "../src/config.ts";
import { checkHealth } from "../src/health.ts";
import { runMigrations } from "../src/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/**
 * Integration lane. Runs against a real PostgreSQL 18:
 *  - fleet dev: TERMINUS_DB_TEST_SOCKET_DIR names the dev container's socket dir
 *  - CI:        TERMINUS_DB_TEST_HOST names the postgres:18 service container
 *               (TCP is CI's one sanctioned use; trust auth, still no password)
 * Absent both, the lane skips loudly.
 */
function endpointFromTestEnv(env: Record<string, string | undefined>): DbEndpointT | null {
  if (env.TERMINUS_DB_TEST_SOCKET_DIR) {
    return DbEndpoint.parse({
      kind: "socket",
      socket_dir: env.TERMINUS_DB_TEST_SOCKET_DIR,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? "postgres",
      application_name: "terminus-db-integration",
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: "tcp",
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? "postgres",
      username: env.TERMINUS_DB_TEST_USERNAME ?? "postgres",
      application_name: "terminus-db-integration",
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn(
    "[terminus-db] integration lane SKIPPED — set TERMINUS_DB_TEST_SOCKET_DIR (fleet) or TERMINUS_DB_TEST_HOST (CI) to run it",
  );
}

describe.skipIf(!endpoint)("db integration (live postgres 18)", () => {
  let sql: SQL;

  beforeAll(async () => {
    sql = await connectDb(endpoint!);
    await sql`drop table if exists schema_migrations`;
  });

  afterAll(async () => {
    await sql?.close();
  });

  test("the migrations apply and land their ledger rows", async () => {
    const report = await runMigrations(sql, MIGRATIONS_DIR);
    expect(report.applied.map(m => m.id)).toEqual([1, 2, 3, 4]);
    expect(report.alreadyApplied).toBe(0);
  });

  test("re-running the runner is a no-op (idempotence)", async () => {
    const report = await runMigrations(sql, MIGRATIONS_DIR);
    expect(report.applied).toEqual([]);
    expect(report.alreadyApplied).toBe(4);
  });

  test("concurrent boot: two connections migrate simultaneously without racing the ledger", async () => {
    // txd and busd both run runMigrations at boot. The advisory-lock guard
    // serializes them: exactly one applies each pending id, the other re-plans
    // under the lock to a no-op — never a duplicate ledger insert.
    await sql`drop table if exists schema_migrations`;
    const sql2 = await connectDb(endpoint!);
    try {
      const [a, b] = await Promise.all([
        runMigrations(sql, MIGRATIONS_DIR),
        runMigrations(sql2, MIGRATIONS_DIR),
      ]);
      expect(a.applied.length + b.applied.length).toBe(4);
      const LedgerRow = z.object({ id: z.number().int() });
      const rows = await typedRows(sql, LedgerRow)`select id from schema_migrations order by id`;
      expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4]);
    } finally {
      await sql2.close();
    }
  });

  test("checkHealth reports up on server_version 18.x", async () => {
    const report = await checkHealth(endpoint!);
    expect(report.status).toBe("up");
    if (report.status === "up") {
      expect(report.server_version).toStartWith("18.");
    }
  });

  test("typedRows parse-validates reads at the boundary", async () => {
    const LedgerRow = z.object({ id: z.number().int(), name: z.string() });
    const rows = await typedRows(sql, LedgerRow)`
      select id, name from schema_migrations order by id
    `;
    expect(rows).toEqual([
      { id: 1, name: "schema_migrations" },
      { id: 2, name: "txd_events" },
      { id: 3, name: "desktop_telemetry" },
      { id: 4, name: "bus" },
    ]);

    const WrongRow = z.object({ id: z.string() });
    await expect(
      typedRows(sql, WrongRow)`select id from schema_migrations`,
    ).rejects.toThrow();
  });

  test("connectDb fails loud on a dead endpoint (no retry-forever)", async () => {
    const dead = DbEndpoint.parse({
      kind: "socket",
      socket_dir: "/nonexistent/terminus-db-test",
      database: "postgres",
      application_name: "terminus-db-integration",
    });
    await expect(connectDb(dead)).rejects.toThrow(/connect failed/);
  });
});
