// Event store (spec §2) — the single source of truth.
//
// One append-only Postgres table (`txd.events`), ONE writer. Truth is the
// stream; every displayed status is a derived view (see projections.ts).
// Retention is keep-forever day-one; no snapshots (replay-from-zero every
// reconcile, honestly measured). The 8 columns are exactly the ruled shape —
// nothing derived is stored on the write side.
//
// Append-only is STRUCTURAL, not conventional: database triggers raise on any
// UPDATE, DELETE, or TRUNCATE, so a stray writer cannot silently rewrite
// history. The schema lives in the shared forward-only migrations
// (packages/db/migrations, `0002_txd_events.sql`) and is applied at connect().
//
// `MemoryEventStore` is the deterministic test seam — FakeTmux's sibling
// (tmux.ts precedent). Append-only by construction: no mutation surface exists.

import type { SQL } from 'bun';
import { connectDb, runMigrations, MIGRATIONS_DIR, type DbEndpointT } from '@terminus-os/db';
import {
  EventInputSchema,
  EventRecordSchema,
  type EventInput,
  type EventRecord,
} from '@terminus-os/contracts';
import { assertNoTmuxId } from './ids.ts';

export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export interface EventStore {
  /** Append one event. The store assigns seq (monotonic) and recorded_at. */
  append(input: EventInput): Promise<EventRecord>;
  /** Append many events in one transaction (single-writer batch). */
  appendAll(inputs: EventInput[]): Promise<EventRecord[]>;
  /** Atomically append a prefix, then events derived from its persisted records. */
  appendDerived(inputs: EventInput[], derive: (written: EventRecord[]) => EventInput[]): Promise<EventRecord[]>;
  /** Full stream in seq order — the replay source. */
  readAll(): Promise<EventRecord[]>;
  readByEntity(entityId: string): Promise<EventRecord[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}

type Row = {
  seq: number | bigint | string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: unknown;
  provenance: unknown;
  occurred_at: string;
  recorded_at: string;
};

// Parse-validated read boundary (the @terminus-os/db typedRows discipline):
// seq (int8) is normalized to a number and jsonb columns are decoded before
// the contract schema pins the record shape. Bun.SQL delivers jsonb as a
// structured value on some protocol paths and as raw JSON text on others
// (prepared statements in Bun 1.3.x) — the boundary decodes either honestly;
// contract payloads/provenance are objects, so a string can only be wire text.
const asJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
function rowToRecord(r: Row): EventRecord {
  return EventRecordSchema.parse({
    ...r,
    seq: Number(r.seq),
    payload: asJson(r.payload),
    provenance: asJson(r.provenance),
  });
}

export class PostgresEventStore implements EventStore {
  private constructor(
    private sql: SQL,
    private now: Clock,
  ) {}

  /**
   * Connect to the endpoint and ensure the schema: forward-only migrations
   * run at boot, so a pristine database and a current one converge on the
   * same shape. Fail-loud throughout — a dead database throws here.
   */
  static async connect(endpoint: DbEndpointT, now: Clock = systemClock): Promise<PostgresEventStore> {
    const sql = await connectDb(endpoint);
    await runMigrations(sql, MIGRATIONS_DIR);
    return new PostgresEventStore(sql, now);
  }

  private async insert(sql: SQL, input: EventInput): Promise<EventRecord> {
    assertNoTmuxId(input, 'event_input');
    const parsed = EventInputSchema.parse(input);
    const recorded_at = this.now();
    const rows = (await sql`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES (${parsed.entity_type}, ${parsed.entity_id}, ${parsed.event_type},
              ${JSON.stringify(parsed.payload)}::jsonb, ${JSON.stringify(parsed.provenance)}::jsonb,
              ${parsed.occurred_at}, ${recorded_at})
      RETURNING seq`) as { seq: number | bigint | string }[];
    return { ...parsed, seq: Number(rows[0]!.seq), recorded_at };
  }

  append(input: EventInput): Promise<EventRecord> {
    return this.insert(this.sql, input);
  }

  appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    for (const input of inputs) assertNoTmuxId(input, 'event_input');
    return this.sql.begin(async (tx) => {
      const out: EventRecord[] = [];
      for (const input of inputs) out.push(await this.insert(tx, input));
      return out;
    }) as Promise<EventRecord[]>;
  }

  appendDerived(inputs: EventInput[], derive: (written: EventRecord[]) => EventInput[]): Promise<EventRecord[]> {
    for (const input of inputs) assertNoTmuxId(input, 'event_input');
    return this.sql.begin(async (tx) => {
      const prefix: EventRecord[] = [];
      for (const input of inputs) prefix.push(await this.insert(tx, input));
      const suffixInputs = derive(prefix);
      const suffix: EventRecord[] = [];
      for (const input of suffixInputs) suffix.push(await this.insert(tx, input));
      return [...prefix, ...suffix];
    }) as Promise<EventRecord[]>;
  }

  async readAll(): Promise<EventRecord[]> {
    const rows = (await this.sql`
      SELECT seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at
      FROM txd.events ORDER BY seq`) as Row[];
    return rows.map(rowToRecord);
  }

  async readByEntity(entityId: string): Promise<EventRecord[]> {
    const rows = (await this.sql`
      SELECT seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at
      FROM txd.events WHERE entity_id = ${entityId} ORDER BY seq`) as Row[];
    return rows.map(rowToRecord);
  }

  async count(): Promise<number> {
    const rows = (await this.sql`SELECT count(*)::int AS n FROM txd.events`) as { n: number }[];
    return rows[0]!.n;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export class MemoryEventStore implements EventStore {
  private events: EventRecord[] = [];

  constructor(private now: Clock = systemClock) {}

  private commit(parsed: EventInput): EventRecord {
    const rec: EventRecord = { ...parsed, seq: this.events.length + 1, recorded_at: this.now() };
    this.events.push(rec);
    return rec;
  }

  async append(input: EventInput): Promise<EventRecord> {
    assertNoTmuxId(input, 'event_input');
    return this.commit(EventInputSchema.parse(input));
  }

  async appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    // Validate the whole batch before committing any of it (transactional).
    for (const input of inputs) assertNoTmuxId(input, 'event_input');
    const parsed = inputs.map((i) => EventInputSchema.parse(i));
    return parsed.map((p) => this.commit(p));
  }

  async appendDerived(inputs: EventInput[], derive: (written: EventRecord[]) => EventInput[]): Promise<EventRecord[]> {
    for (const input of inputs) assertNoTmuxId(input, 'event_input');
    const parsedPrefix = inputs.map((input) => EventInputSchema.parse(input));
    const base = this.events.length;
    const prefix = parsedPrefix.map((input, index): EventRecord => ({
      ...input, seq: base + index + 1, recorded_at: this.now(),
    }));
    const suffixInputs = derive(prefix);
    for (const input of suffixInputs) assertNoTmuxId(input, 'event_input');
    const parsedSuffix = suffixInputs.map((input) => EventInputSchema.parse(input));
    const suffix = parsedSuffix.map((input, index): EventRecord => ({
      ...input, seq: base + prefix.length + index + 1, recorded_at: this.now(),
    }));
    this.events.push(...prefix, ...suffix);
    return [...prefix, ...suffix];
  }

  async readAll(): Promise<EventRecord[]> {
    return [...this.events];
  }

  async readByEntity(entityId: string): Promise<EventRecord[]> {
    return this.events.filter((e) => e.entity_id === entityId);
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  async close(): Promise<void> {}
}
