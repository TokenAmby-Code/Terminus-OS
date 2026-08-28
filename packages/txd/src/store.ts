// Event store (spec §2) — the single source of truth.
//
// One append-only Postgres table (`txd.events`), ONE writer. The production
// codebase has exactly one INSERT boundary: PostgresEventStore below. The tx
// CLI uses txd's HTTP surface, k12-work has no database path into this table,
// and migrations run before the store is returned to the daemon. Truth is the
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
import { buildProjections } from './projections.ts';
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
  /** Observe records committed through this process's sole writer boundary. */
  onAppend(listener: (event: EventRecord) => void): () => void;
  /** Full stream in seq order — the replay source. */
  readAll(signal?: AbortSignal): Promise<EventRecord[]>;
  readByEntity(entityId: string): Promise<EventRecord[]>;
  count(signal?: AbortSignal): Promise<number>;
  /** Read-only dependency evidence for the observation contract. */
  observePostgres(signal: AbortSignal): Promise<Record<string, unknown>>;
  /** Bounded current-binding projection; never scans the event log in the health handler. */
  unresolvedCommTransportTargets(signal: AbortSignal): Promise<string[]>;
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

type Cancellable<T> = PromiseLike<T> & { cancel(): unknown };

async function queryWithSignal<T>(query: Cancellable<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await query;
  if (signal.aborted) {
    query.cancel();
    throw signal.reason ?? new Error('observation_aborted');
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      try { query.cancel(); } finally { reject(signal.reason ?? new Error('observation_aborted')); }
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve(query), aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

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
  private appendListeners = new Set<(event: EventRecord) => void>();
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
    // Migration 0005 normalized
    // the historical string rows in place.
    const rows = (await sql`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES (${parsed.entity_type}, ${parsed.entity_id}, ${parsed.event_type},
              ${parsed.payload}, ${parsed.provenance},
              ${parsed.occurred_at}, ${recorded_at})
      RETURNING seq`) as { seq: number | bigint | string }[];
    return { ...parsed, seq: Number(rows[0]!.seq), recorded_at };
  }

  async append(input: EventInput): Promise<EventRecord> {
    const record = await this.insert(this.sql, input);
    this.notifyAppend(record);
    return record;
  }

  async appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    for (const input of inputs) assertNoTmuxIdInIdentifiers(input, 'event_input');
    const records = await this.sql.begin(async (tx) => {
      const out: EventRecord[] = [];
      for (const input of inputs) out.push(await this.insert(tx, input));
      return out;
    }) as EventRecord[];
    for (const record of records) this.notifyAppend(record);
    return records;
  }

  onAppend(listener: (event: EventRecord) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  private notifyAppend(event: EventRecord): void {
    for (const listener of this.appendListeners) listener(event);
  }

  async readAll(signal?: AbortSignal): Promise<EventRecord[]> {
    const rows = await queryWithSignal(this.sql`
      SELECT seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at
      FROM txd.events ORDER BY seq` as Cancellable<Row[]>, signal);
    return rows.map(rowToRecord);
  }

  async readByEntity(entityId: string): Promise<EventRecord[]> {
    const rows = (await this.sql`
      SELECT seq, entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at
      FROM txd.events WHERE entity_id = ${entityId} ORDER BY seq`) as Row[];
    return rows.map(rowToRecord);
  }

  async count(signal?: AbortSignal): Promise<number> {
    const rows = await queryWithSignal(
      this.sql`SELECT count(*)::int AS n FROM txd.events` as Cancellable<{ n: number }[]>,
      signal,
    );
    return rows[0]!.n;
  }

  async observePostgres(signal: AbortSignal): Promise<Record<string, unknown>> {
    const rows = await queryWithSignal(this.sql`
      SELECT 1::int AS select_1,
             current_database() AS database,
             current_user AS connection_identity,
             current_setting('server_version') AS server_version
    ` as Cancellable<Array<{ select_1: number; database: string; connection_identity: string; server_version: string }>>, signal);
    if (rows[0]?.select_1 !== 1) throw new Error('postgres reachability query returned no row');
    return rows[0];
  }

  async unresolvedCommTransportTargets(signal: AbortSignal): Promise<string[]> {
    const rows = await queryWithSignal(this.sql`
      WITH checkpoint AS (
        SELECT seq, payload FROM txd.events
        WHERE event_type = 'estate.compaction_checkpoint'
        ORDER BY seq DESC LIMIT 1
      ), base_bindings AS (
        SELECT checkpoint.seq, binding->>'seat_id' AS seat_id,
               binding->>'agent_id' AS agent_id, false AS cleared
        FROM checkpoint,
             jsonb_array_elements(checkpoint.payload->'current_bindings') binding
      ), binding_events AS (
        SELECT seq, entity_id AS seat_id, payload->>'agent_id' AS agent_id, false AS cleared
        FROM txd.events
        WHERE event_type = 'reg.bound'
          AND seq > coalesce((SELECT seq FROM checkpoint), 0)
        UNION ALL
        SELECT seq, entity_id AS seat_id, NULL::text AS agent_id, true AS cleared
        FROM txd.events
        WHERE event_type IN ('reg.seat_cleared', 'reg.seat_abandoned')
          AND seq > coalesce((SELECT seq FROM checkpoint), 0)
        UNION ALL SELECT * FROM base_bindings
      ), current_bindings AS (
        SELECT DISTINCT ON (seat_id) seat_id, agent_id, cleared
        FROM binding_events ORDER BY seat_id, seq DESC
      ), transport AS (
        SELECT payload->>'target_agent_id' AS agent_id,
               max(seq) FILTER (
                 WHERE event_type = 'act.comm_bytes_sent'
                   AND payload->>'submit_verdict' = 'transport_failed'
                   AND coalesce((payload->>'bytes')::int, 0) = 0
               ) AS failure_seq,
               max(seq) FILTER (WHERE event_type = 'act.comm_delivery_asserted') AS recovery_seq
        FROM txd.events
        WHERE event_type IN ('act.comm_bytes_sent', 'act.comm_delivery_asserted')
          AND payload ? 'target_agent_id'
        GROUP BY payload->>'target_agent_id'
      )
      SELECT transport.agent_id
      FROM transport
      JOIN current_bindings ON current_bindings.agent_id = transport.agent_id
      WHERE NOT current_bindings.cleared
        AND transport.failure_seq IS NOT NULL
        AND transport.failure_seq > coalesce(transport.recovery_seq, 0)
      ORDER BY transport.agent_id
    ` as Cancellable<Array<{ agent_id: string }>>, signal);
    return rows.map((row) => row.agent_id);
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
  private appendListeners = new Set<(event: EventRecord) => void>();

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
    const record = this.commit(EventInputSchema.parse(input));
    this.notifyAppend(record);
    return record;
  }

  async appendAll(inputs: EventInput[]): Promise<EventRecord[]> {
    // Validate the whole batch before committing any of it (transactional).
    for (const input of inputs) assertNoTmuxIdInIdentifiers(input, 'event_input');
    const parsed = inputs.map((i) => EventInputSchema.parse(i));
    const records = parsed.map((p) => this.commit(p));
    for (const record of records) this.notifyAppend(record);
    return records;
  }

  onAppend(listener: (event: EventRecord) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  private notifyAppend(event: EventRecord): void {
    for (const listener of this.appendListeners) listener(event);
  }

  async readAll(signal?: AbortSignal): Promise<EventRecord[]> {
    if (signal?.aborted) throw signal.reason ?? new Error('observation_aborted');
    return [...this.events];
  }

  async readByEntity(entityId: string): Promise<EventRecord[]> {
    return this.events.filter((e) => e.entity_id === entityId);
  }

  async count(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw signal.reason ?? new Error('observation_aborted');
    return this.events.length;
  }

  async observePostgres(signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) throw signal.reason ?? new Error('observation_aborted');
    return { select_1: 1, database: 'memory', connection_identity: 'memory', server_version: 'memory' };
  }

  async unresolvedCommTransportTargets(signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) throw signal.reason ?? new Error('observation_aborted');
    const currentAgentIds = new Set(buildProjections(this.events).currentBindings
      .map((binding) => binding.agent_id).filter((agent): agent is string => agent !== null));
    const unresolved = new Map<string, number>();
    for (const event of this.events) {
      const target = typeof event.payload.target_agent_id === 'string' ? event.payload.target_agent_id : null;
      if (!target || !currentAgentIds.has(target)) continue;
      if (event.event_type === 'act.comm_bytes_sent'
        && event.payload.submit_verdict === 'transport_failed' && event.payload.bytes === 0) unresolved.set(target, event.seq);
      if (event.event_type === 'act.comm_delivery_asserted') unresolved.delete(target);
    }
    return [...unresolved.keys()].sort();
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
