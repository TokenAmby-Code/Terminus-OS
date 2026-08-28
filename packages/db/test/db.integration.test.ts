import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SQL } from "bun";
import { connectDb } from "../src/client.ts";
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
      max: 1,
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
      max: 1,
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
    await resetTestDatabase(sql);
    await runMigrations(sql, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await sql?.close();
  });

  test("checkHealth reports up on server_version 18.x", async () => {
    const report = await checkHealth(endpoint!);
    expect(report.status).toBe("up");
    if (report.status === "up") {
      expect(report.server_version).toStartWith("18.");
    }
  });

  test("replay timestamp validation is immutable without accepting impossible dates", async () => {
    const rows = (await sql`
      SELECT p.provolatile,
             replay.is_timestamptz('2026-07-26T17:00:00.000Z') AS valid,
             replay.is_timestamptz('2026-02-31T17:00:00.000Z') AS impossible
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'replay' AND p.proname = 'is_timestamptz'`) as Array<{
        provolatile: string;
        valid: boolean;
        impossible: boolean;
      }>;
    expect(rows).toEqual([{ provolatile: "i", valid: true, impossible: false }]);

    const indexes = (await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'replay'
        AND indexname = 'replay_delivery_attempts_success'`) as Array<{ indexname: string }>;
    expect(indexes).toEqual([{ indexname: "replay_delivery_attempts_success" }]);
  });

  test("open replay work is materialized and indexed by machine and transaction kind", async () => {
    const columns = (await sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'replay' AND table_name = 'streams'
        AND column_name IN ('first_event_type', 'machine', 'terminal')
      ORDER BY column_name`) as Array<{ column_name: string; is_nullable: string }>;
    expect(columns).toEqual([
      { column_name: "first_event_type", is_nullable: "NO" },
      { column_name: "machine", is_nullable: "NO" },
      { column_name: "terminal", is_nullable: "NO" },
    ]);
    const indexes = (await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'replay'
        AND indexname IN ('replay_open_commands_by_machine', 'replay_open_non_operations_by_machine')
      ORDER BY indexname`) as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "replay_open_commands_by_machine",
      "replay_open_non_operations_by_machine",
    ]);
  });

  test("connectDb fails loud on a dead endpoint (no retry-forever)", async () => {
    const dead = DbEndpoint.parse({
      kind: "socket",
      socket_dir: "/nonexistent/terminus-db-test",
      database: "postgres",
      application_name: "terminus-db-integration",
      max: 1,
    });
    await expect(connectDb(dead)).rejects.toThrow(/connect failed/);
  });

});

async function resetTestDatabase(sql: SQL): Promise<void> {
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS replay CASCADE;
    DROP SCHEMA IF EXISTS bus CASCADE;
    DROP SCHEMA IF EXISTS telemetry CASCADE;
    DROP SCHEMA IF EXISTS txd CASCADE;
    DROP TABLE IF EXISTS public.schema_migrations;
  `);
}
