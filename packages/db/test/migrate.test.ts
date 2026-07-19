import { describe, expect, test } from "bun:test";
import { planMigrations } from "../src/migrate.ts";
import { DbHealthReport } from "../src/health.ts";

describe("migration planning (pure, forward-only)", () => {
  test("orders numerically and returns only pending migrations", () => {
    const pending = planMigrations(
      ["0003_third.sql", "0001_schema_migrations.sql", "0002_second.sql"],
      [1],
    );
    expect(pending.map(m => m.id)).toEqual([2, 3]);
    expect(pending[0]).toEqual({ id: 2, name: "second", filename: "0002_second.sql" });
  });

  test("a fully applied ledger plans to a no-op", () => {
    expect(planMigrations(["0001_schema_migrations.sql"], [1])).toEqual([]);
  });

  test("non-migration files in migrations/ are a loud failure", () => {
    expect(() => planMigrations(["0001_schema_migrations.sql", "notes.md"], [])).toThrow(
      /non-migration file/,
    );
    expect(() => planMigrations(["1_short.sql"], [])).toThrow(/non-migration file/);
  });

  test("duplicate migration ids are a loud failure", () => {
    expect(() => planMigrations(["0001_a.sql", "0001_b.sql"], [])).toThrow(/duplicate/);
  });

  test("an applied id missing from disk means rewritten history — loud failure", () => {
    expect(() => planMigrations(["0002_second.sql"], [1])).toThrow(/rewritten/);
  });

  test("backfilling below an applied id is a loud failure", () => {
    expect(() =>
      planMigrations(["0001_late_insert.sql", "0002_second.sql"], [2]),
    ).toThrow(/forward-only/);
  });
});

describe("health report contract", () => {
  test("status up is unparseable for a non-18 server_version", () => {
    const endpoint = "socket /var/run/postgresql/.s.PGSQL.5432 db=terminus";
    expect(() =>
      DbHealthReport.parse({ status: "up", server_version: "17.5", endpoint }),
    ).toThrow();
    expect(
      DbHealthReport.parse({ status: "up", server_version: "18.1", endpoint }).status,
    ).toBe("up");
  });

  test("down requires a reason", () => {
    expect(() =>
      DbHealthReport.parse({ status: "down", reason: "", endpoint: "x" }),
    ).toThrow();
  });
});
