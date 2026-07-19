import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

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

async function appliedMigrationIds(sql: SQL): Promise<number[]> {
  try {
    const rows = await sql`select id from schema_migrations order by id`;
    return (rows as { id: number }[]).map(r => r.id);
  } catch (err) {
    // 42P01 undefined_table: pristine database — migration 0001 creates the ledger.
    // Bun 1.3.x surfaces the SQLSTATE on `errno` (`code` holds ERR_POSTGRES_SERVER_ERROR).
    if (err instanceof SQL.PostgresError && err.errno === "42P01") return [];
    throw err;
  }
}

/**
 * Apply every pending migration, each inside its own transaction alongside its
 * schema_migrations row. Failure throws and rolls back the failing migration;
 * previously applied ones stay applied (forward-only, no down migrations).
 */
export async function runMigrations(sql: SQL, migrationsDir: string): Promise<MigrationReport> {
  const filenames = await readdir(migrationsDir);
  const appliedIds = await appliedMigrationIds(sql);
  const pending = planMigrations(filenames, appliedIds);

  for (const migration of pending) {
    const text = await Bun.file(join(migrationsDir, migration.filename)).text();
    await sql.begin(async tx => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (id, name) values (${migration.id}, ${migration.name})`;
    });
  }

  return { applied: pending, alreadyApplied: appliedIds.length };
}
