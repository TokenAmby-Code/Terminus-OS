// Bus store (central-bus ruling) — the journal + config + cursor surface.
//
// One append-only Postgres journal (`bus.events`), ONE writer: busd. Sibling
// idiom to txd's private stream (0002): jsonb facts, verbatim ISO strings,
// structural immutability via triggers. The schema lives in the shared
// forward-only migrations (packages/db/migrations, `0004_bus.sql`) and is
// applied at connect().
//
// Subscription matching is a SQL LIKE pattern evaluated IN the delivery query,
// so psql and busd agree by construction. `MemoryBusStore` is the deterministic
// test seam (txd's MemoryEventStore precedent); its `likeToRegExp` mirror is
// parity-tested against live Postgres in the gated store lane.

import type { SQL } from 'bun';
import { connectDb, runMigrations, MIGRATIONS_DIR, typedRows, type DbEndpointT } from '@terminus-os/db';
import {
  BusEventInputSchema,
  BusEventRecordSchema,
  BusLagRowSchema,
  BusSubscriptionRowSchema,
  type BusEventInput,
  type BusEventRecord,
  type BusLagRow,
  type BusSubscriptionRow,
} from '@terminus-os/contracts';

export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export interface BusStore {
  /** Append one event. The store assigns seq (monotonic) and recorded_at. */
  append(input: BusEventInput): Promise<BusEventRecord>;
  /** Events with seq > afterSeq matching the SQL LIKE pattern, in seq order, bounded. */
  readSince(afterSeq: number, pattern: string, limit: number): Promise<BusEventRecord[]>;
  activeSubscriptions(): Promise<BusSubscriptionRow[]>;
  /** Durable delivery cursor; null = never seeded (an explicit runbook step is outstanding). */
  cursor(subscription: string): Promise<number | null>;
  /** Monotonic upsert — an existing cursor never regresses. */
  advanceCursor(subscription: string, seq: number): Promise<void>;
  /** Per-subscription lag (the bus.lag view; Memory computes the same shape). */
  lag(): Promise<BusLagRow[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}

/** SQL LIKE (%, _) → anchored RegExp — MemoryBusStore's matching mirror. */
export function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`);
}

type EventRow = {
  seq: number | bigint | string;
  event_type: string;
  source: string;
  payload: unknown;
  provenance: unknown;
  occurred_at: string;
  recorded_at: string;
};

// Parse-validated read boundary (the @terminus-os/db typedRows discipline):
// seq (int8) is normalized to a number and jsonb columns are decoded before
// the contract schema pins the record shape. Bun.SQL delivers jsonb as a
// structured value on some protocol paths and as raw JSON text on others —
// the boundary decodes either honestly.
const asJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
function rowToRecord(r: EventRow): BusEventRecord {
  return BusEventRecordSchema.parse({
    ...r,
    seq: Number(r.seq),
    payload: asJson(r.payload),
    provenance: asJson(r.provenance),
  });
}

export class PostgresBusStore implements BusStore {
  private constructor(
    private sql: SQL,
    private now: Clock,
  ) {}

  /**
   * Connect to the endpoint and ensure the schema: forward-only migrations run
   * at boot (serialized against concurrent booters by the migration advisory
   * lock). Fail-loud throughout — a dead database throws here; there is no
   * fallback path anywhere in busd.
   */
  static async connect(endpoint: DbEndpointT, now: Clock = systemClock): Promise<PostgresBusStore> {
    const sql = await connectDb(endpoint);
    await runMigrations(sql, MIGRATIONS_DIR);
    return new PostgresBusStore(sql, now);
  }

  async append(input: BusEventInput): Promise<BusEventRecord> {
    const parsed = BusEventInputSchema.parse(input);
    const recorded_at = this.now();
    // Objects are passed DIRECTLY so Bun.SQL binds real jsonb objects. The
    // txd-store idiom (`JSON.stringify(x)::jsonb`) double-encodes: the cast
    // receives an already-JSON-encoded parameter and stores a jsonb *string*,
    // which poisons the ruled psql surface (payload->>'k' returns nothing).
    // The read boundary (rowToRecord/asJson) tolerates both shapes, so the
    // handful of pre-fix string rows in the live journal replay unchanged.
    const rows = (await this.sql`
      INSERT INTO bus.events (event_type, source, payload, provenance, occurred_at, recorded_at)
      VALUES (${parsed.event_type}, ${parsed.source},
              ${parsed.payload}, ${parsed.provenance},
              ${parsed.occurred_at}, ${recorded_at})
      RETURNING seq`) as { seq: number | bigint | string }[];
    return { ...parsed, seq: Number(rows[0]!.seq), recorded_at };
  }

  async readSince(afterSeq: number, pattern: string, limit: number): Promise<BusEventRecord[]> {
    const rows = (await this.sql`
      SELECT seq, event_type, source, payload, provenance, occurred_at, recorded_at
      FROM bus.events
      WHERE seq > ${afterSeq} AND event_type LIKE ${pattern}
      ORDER BY seq
      LIMIT ${limit}`) as EventRow[];
    return rows.map(rowToRecord);
  }

  async activeSubscriptions(): Promise<BusSubscriptionRow[]> {
    return typedRows(this.sql, BusSubscriptionRowSchema)`
      SELECT name, delivery_url, event_pattern, active
      FROM bus.subscriptions WHERE active ORDER BY name`;
  }

  async cursor(subscription: string): Promise<number | null> {
    const rows = (await this.sql`
      SELECT acked_seq FROM bus.cursors WHERE subscription_name = ${subscription}`) as {
      acked_seq: number | bigint | string;
    }[];
    return rows.length ? Number(rows[0]!.acked_seq) : null;
  }

  async advanceCursor(subscription: string, seq: number): Promise<void> {
    await this.sql`
      INSERT INTO bus.cursors (subscription_name, acked_seq)
      VALUES (${subscription}, ${seq})
      ON CONFLICT (subscription_name) DO UPDATE
        SET acked_seq = excluded.acked_seq, advanced_at = now()
        WHERE bus.cursors.acked_seq < excluded.acked_seq`;
  }

  async lag(): Promise<BusLagRow[]> {
    const rows = (await this.sql`
      SELECT name, active, event_pattern, acked_seq, lag FROM bus.lag ORDER BY name`) as {
      name: string;
      active: boolean;
      event_pattern: string;
      acked_seq: number | bigint | string | null;
      lag: number | bigint | string;
    }[];
    return rows.map((r) =>
      BusLagRowSchema.parse({
        ...r,
        acked_seq: r.acked_seq === null ? null : Number(r.acked_seq),
        lag: Number(r.lag),
      }),
    );
  }

  async count(): Promise<number> {
    const rows = (await this.sql`SELECT count(*)::int AS n FROM bus.events`) as { n: number }[];
    return rows[0]!.n;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export class MemoryBusStore implements BusStore {
  private events: BusEventRecord[] = [];
  private subscriptions = new Map<string, BusSubscriptionRow>();
  private cursors = new Map<string, number>();

  constructor(private now: Clock = systemClock) {}

  /** Test seam: declare a subscription (the live table is operator-seeded via psql). */
  setSubscription(row: BusSubscriptionRow): void {
    this.subscriptions.set(row.name, BusSubscriptionRowSchema.parse(row));
  }

  /** Test seam: the explicit cursor-seeding runbook step. */
  seedCursor(subscription: string, seq: number): void {
    this.cursors.set(subscription, seq);
  }

  async append(input: BusEventInput): Promise<BusEventRecord> {
    const parsed = BusEventInputSchema.parse(input);
    const rec: BusEventRecord = { ...parsed, seq: this.events.length + 1, recorded_at: this.now() };
    this.events.push(rec);
    return rec;
  }

  async readSince(afterSeq: number, pattern: string, limit: number): Promise<BusEventRecord[]> {
    const match = likeToRegExp(pattern);
    return this.events.filter((e) => e.seq > afterSeq && match.test(e.event_type)).slice(0, limit);
  }

  async activeSubscriptions(): Promise<BusSubscriptionRow[]> {
    return [...this.subscriptions.values()].filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name));
  }

  async cursor(subscription: string): Promise<number | null> {
    return this.cursors.get(subscription) ?? null;
  }

  async advanceCursor(subscription: string, seq: number): Promise<void> {
    const current = this.cursors.get(subscription);
    if (current === undefined || current < seq) this.cursors.set(subscription, seq);
  }

  async lag(): Promise<BusLagRow[]> {
    // ALL subscriptions, inactive included — the bus.lag view's exact scope.
    const all = [...this.subscriptions.values()].sort((a, b) => a.name.localeCompare(b.name));
    return all.map((s) => {
      const acked = this.cursors.get(s.name) ?? null;
      const match = likeToRegExp(s.event_pattern);
      const lag = this.events.filter((e) => e.seq > (acked ?? 0) && match.test(e.event_type)).length;
      return { name: s.name, active: s.active, event_pattern: s.event_pattern, acked_seq: acked, lag };
    });
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  async close(): Promise<void> {}
}
