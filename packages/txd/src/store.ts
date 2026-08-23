// Event store (spec §2) — the single source of truth.
//
// One append-only Postgres table (`txd.events`), ONE writer. Truth is the
// stream; every displayed status is a derived view (see projections.ts).
// Retention is operator-gated at completed estate generations. A compacted
// prefix becomes one projection checkpoint at the same sequence; open cohorts
// and the current generation remain ordinary events. The event table keeps the
// ruled 8-column shape.
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
  type EventLogCompactionRequest,
  type EventInput,
  type EventRecord,
} from '@terminus-os/contracts';
import { assertNoTmuxIdInIdentifiers } from './ids.ts';
import {
  archivedEventDigest,
  compactEventRecords,
  compactionResult,
  openEventSeqs,
  type EventLogCompactionResult,
} from './event-log-compaction.ts';

export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export interface EventStore {
  /** Append one event. The store assigns seq (monotonic) and recorded_at. */
  append(input: EventInput): Promise<EventRecord>;
  /** Append many events in one transaction (single-writer batch). */
  appendAll(inputs: EventInput[]): Promise<EventRecord[]>;
  /** Full stream in seq order — the replay source. */
  readAll(): Promise<EventRecord[]>;
  readByEntity(entityId: string): Promise<EventRecord[]>;
  count(): Promise<number>;
  compact(request: EventLogCompactionRequest): Promise<EventLogCompactionResult>;
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
    assertNoTmuxIdInIdentifiers(input, 'event_input');
    const parsed = EventInputSchema.parse(input);
    const recorded_at = this.now();
    // Objects are passed DIRECTLY so Bun.SQL binds real jsonb objects. The
    // old idiom (`JSON.stringify(x)::jsonb`) double-encodes: the cast
    // receives an already-JSON-encoded parameter and stores a jsonb *string*,
    // which poisons the ruled psql surface (payload->>'k' returns nothing).
    // Same defect and fix as busd #34 (af8088e9); migration 0005 normalized
    // the historical string rows in place.
    const rows = (await sql`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES (${parsed.entity_type}, ${parsed.entity_id}, ${parsed.event_type},
              ${parsed.payload}, ${parsed.provenance},
              ${parsed.occurred_at}, ${recorded_at})
      RETURNING seq`) as { seq: number | bigint | string }[];
    return { ...parsed, seq: Number(rows[0]!.seq), recorded_at };
  }

  append(input: EventInput): Promise<EventRecord> {
    return this.insert(this.sql, input);
  }

  appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    for (const input of inputs) assertNoTmuxIdInIdentifiers(input, 'event_input');
    return this.sql.begin(async (tx) => {
      const out: EventRecord[] = [];
      for (const input of inputs) out.push(await this.insert(tx, input));
      return out;
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

  async compact(request: EventLogCompactionRequest): Promise<EventLogCompactionResult> {
    return this.sql.begin(async (tx) => {
      const resetRows = (await tx`
        SELECT recorded_at::text AS recorded_at
        FROM journal.events WHERE seq = ${request.reset_journal_head}`) as { recorded_at: string }[];
      if (resetRows.length !== 1) throw new Error('reset_journal_head_absent');
      const prior = (await tx`
        SELECT reset_journal_head FROM txd.event_compactions
        WHERE reset_journal_head = ${request.reset_journal_head}`) as { reset_journal_head: number | bigint | string }[];
      if (prior.length > 0) throw new Error('event_log_already_compacted');
      const boundaries = (await tx`
        SELECT seq, entity_id
        FROM txd.events
        WHERE event_type = 'estate.rotation_completed'
          AND occurred_at::timestamptz <= ${resetRows[0]!.recorded_at}::timestamptz
        ORDER BY seq DESC LIMIT 1`) as { seq: number | bigint | string; entity_id: string }[];
      if (boundaries.length !== 1) throw new Error('estate_generation_boundary_absent');
      const boundary_seq = Number(boundaries[0]!.seq);
      const rows = (await tx`
        SELECT seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at
        FROM txd.events ORDER BY seq`) as Row[];
      const before = rows.map(rowToRecord);
      const resolved = {
        boundary_seq,
        reset_journal_head: request.reset_journal_head,
        archive_attestation: request.archive_attestation,
      };
      const after = compactEventRecords(before, resolved);
      const open = openEventSeqs(before, boundary_seq);
      const archived = before.filter((event) => event.seq <= boundary_seq && !open.has(event.seq));
      const archived_digest = archivedEventDigest(archived);
      await tx`
        INSERT INTO txd.event_compactions
          (reset_journal_head, boundary_seq, boundary_entity_id, archive_attestation,
           archived_events, archived_digest, source_agent_id)
        VALUES (${request.reset_journal_head}, ${boundary_seq}, ${boundaries[0]!.entity_id},
                ${request.archive_attestation}, ${archived.length}, ${archived_digest}, ${request.source_agent_id})`;
      await tx`SELECT set_config('txd.event_compaction', 'archive-attested', true)`;
      const archivedSeqs = archived.map((event) => event.seq);
      const archivedSeqArray = `{${archivedSeqs.join(',')}}`;
      await tx`DELETE FROM txd.events WHERE seq = ANY(${archivedSeqArray}::bigint[])`;
      const checkpoint = after.find((event) => event.event_type === 'estate.compaction_checkpoint')!;
      await tx`
        INSERT INTO txd.events
          (seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
        OVERRIDING SYSTEM VALUE
        VALUES (${checkpoint.seq}, ${checkpoint.entity_type}, ${checkpoint.entity_id}, ${checkpoint.event_type},
                ${checkpoint.payload}, ${checkpoint.provenance}, ${checkpoint.occurred_at}, ${checkpoint.recorded_at})`;
      return compactionResult(before, after, resolved);
    }) as Promise<EventLogCompactionResult>;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

export class MemoryEventStore implements EventStore {
  private events: EventRecord[] = [];
  private nextSeq = 1;

  constructor(private now: Clock = systemClock) {}

  static fromRecords(records: readonly EventRecord[], now: Clock = systemClock): MemoryEventStore {
    const store = new MemoryEventStore(now);
    store.events = records.map((record) => EventRecordSchema.parse(record));
    store.nextSeq = Math.max(0, ...store.events.map((event) => event.seq)) + 1;
    return store;
  }

  private commit(parsed: EventInput): EventRecord {
    const rec: EventRecord = { ...parsed, seq: this.nextSeq++, recorded_at: this.now() };
    this.events.push(rec);
    return rec;
  }

  async append(input: EventInput): Promise<EventRecord> {
    assertNoTmuxIdInIdentifiers(input, 'event_input');
    return this.commit(EventInputSchema.parse(input));
  }

  async appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    // Validate the whole batch before committing any of it (transactional).
    for (const input of inputs) assertNoTmuxIdInIdentifiers(input, 'event_input');
    const parsed = inputs.map((i) => EventInputSchema.parse(i));
    return parsed.map((p) => this.commit(p));
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

  async compact(request: EventLogCompactionRequest): Promise<EventLogCompactionResult> {
    const boundary = [...this.events].reverse().find((event) => event.event_type === 'estate.rotation_completed');
    if (!boundary) throw new Error('estate_generation_boundary_absent');
    const before = [...this.events];
    const resolved = { boundary_seq: boundary.seq, ...request };
    this.events = compactEventRecords(before, resolved);
    return compactionResult(before, this.events, resolved);
  }

  async close(): Promise<void> {}
}
