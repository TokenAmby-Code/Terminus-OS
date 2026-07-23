import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The canonical migrations home — the terminus database's forward-only schema. */
export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

export interface MigrationFile {
  id: number;
  name: string;
  filename: string;
}

export interface MigrationReport {
  applied: MigrationFile[];
  alreadyApplied: number;
}

/**
 * Decide which migrations to run. Pure and loud: any malformed filename,
 * duplicate id, applied-but-missing file, or out-of-order backfill throws —
 * a warped ledger is never silently reconciled.
 */
export function planMigrations(filenames: string[], appliedIds: number[]): MigrationFile[] {
  const files = filenames.map(filename => {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(
        `[terminus-db] migrations dir contains non-migration file "${filename}" (want NNNN_snake_case.sql)`,
      );
    }
    return { id: Number(match[1]), name: match[2] as string, filename };
  });

  files.sort((a, b) => a.id - b.id);
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.id === files[i - 1]!.id) {
      throw new Error(
        `[terminus-db] duplicate migration id ${files[i]!.id} ("${files[i - 1]!.filename}" vs "${files[i]!.filename}")`,
      );
    }
  }

  const onDisk = new Set(files.map(f => f.id));
  for (const id of appliedIds) {
    if (!onDisk.has(id)) {
      throw new Error(
        `[terminus-db] schema_migrations records id ${id} but no such file exists on disk — migration history was rewritten`,
      );
    }
  }

  const applied = new Set(appliedIds);
  const maxApplied = appliedIds.length ? Math.max(...appliedIds) : -Infinity;
  const pending = files.filter(f => !applied.has(f.id));
  for (const f of pending) {
    if (f.id < maxApplied) {
      throw new Error(
        `[terminus-db] migration ${f.filename} was inserted below already-applied id ${maxApplied} — migrations are forward-only`,
      );
    }
  }
  return pending;
}

// One fixed cluster-wide advisory key for the whole migrations home: every
// daemon that runs `runMigrations` at boot (txd, busd, …) serializes on it.
// 0x7465726d = ASCII "term" — arbitrary but fixed and greppable.
export const MIGRATION_LOCK_KEY = 0x7465726d;

async function appliedMigrationIds(sql: SQL): Promise<number[]> {
  // Existence via to_regclass, NOT by catching 42P01: an error would abort the
  // enclosing lock-holding transaction, and a pristine database (migration 0001
  // creates the ledger) is a normal state, not an exception.
  const probe = (await sql`select to_regclass('public.schema_migrations') is not null as found`) as {
    found: boolean;
  }[];
  if (!probe[0]!.found) return [];
  const rows = await sql`select id from schema_migrations order by id`;
  return (rows as { id: number }[]).map(r => r.id);
}

/**
 * Apply every pending migration inside ONE transaction that holds the fixed
 * migration advisory lock (pg_advisory_xact_lock). Multiple daemons running
 * this concurrently at boot serialize: the first applies the pending set, the
 * rest re-plan under the lock and converge to a no-op — the concurrent-boot
 * ledger race is unrepresentable. Failure throws and rolls the whole pending
 * set back (forward-only, no down migrations).
 */
export async function runMigrations(sql: SQL, migrationsDir: string): Promise<MigrationReport> {
  const filenames = await readdir(migrationsDir);
  return (await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    const appliedIds = await appliedMigrationIds(tx);
    const pending = planMigrations(filenames, appliedIds);
    for (const migration of pending) {
      const text = await Bun.file(join(migrationsDir, migration.filename)).text();
      await tx.unsafe(text);
      await tx`insert into schema_migrations (id, name) values (${migration.id}, ${migration.name})`;
    }
    return { applied: pending, alreadyApplied: appliedIds.length };
  })) as MigrationReport;
}
