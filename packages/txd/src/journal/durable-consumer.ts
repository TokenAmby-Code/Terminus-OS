import type { SQL, TransactionSQL } from "bun";

export type JournalEvent = {
  seq: string | number;
  event_id: string;
  event_type: string;
  schema_version: number;
  producer: string;
  producer_role: string;
  estate: string;
  placement: string;
  occurred_at: Date;
  recorded_at: Date;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  stream_id: string | null;
  stream_seq: string | number | null;
  causation_event_id: string | null;
  correlation_id: string | null;
};

export type EventPredicate = { exact?: readonly string[]; prefixes?: readonly string[] };
export type LaneSeed = { kind: "beginning" } | { kind: "now" } | { kind: "seq"; seq: number };
export type JournalLane<T = unknown> = {
  name: string;
  predicate: EventPredicate;
  predicateHash: string;
  seed: LaneSeed;
  batchSize: number;
  decode: (event: JournalEvent) => T;
  handle: (transaction: TransactionSQL, event: T) => Promise<void>;
  afterCommit?: (events: readonly T[]) => Promise<void>;
};

export type DrainResult = {
  cursor: number;
  frontier: number;
  inspected: number;
  applied: number;
  poisoned: number;
};

export interface JournalConsumerStore {
  initializeLane(lane: JournalLane<any>): Promise<void>;
  drainLane(lane: JournalLane<any>): Promise<DrainResult>;
}

export class PoisonEventError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown>) {
    super(code);
    this.name = "PoisonEventError";
  }
}

const identifier = (value: string, label: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`${label} must be a lowercase PostgreSQL identifier`);
  return `"${value}"`;
};

const validateLane = (lane: JournalLane): void => {
  if (!/^[a-z][a-z0-9_-]*$/.test(lane.name)) throw new Error(`invalid lane name: ${lane.name}`);
  const exact = lane.predicate.exact ?? [];
  const prefixes = lane.predicate.prefixes ?? [];
  if (exact.length + prefixes.length === 0) throw new Error(`lane ${lane.name} must declare at least one event predicate`);
  for (const type of exact) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(type)) throw new Error(`lane ${lane.name} has invalid event predicate: ${type}`);
  }
  for (const prefix of prefixes) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(prefix)) throw new Error(`lane ${lane.name} has invalid event predicate: ${prefix}`);
  }
  if (!lane.predicateHash) throw new Error(`lane ${lane.name} must declare its predicate hash`);
  if (!Number.isSafeInteger(lane.batchSize) || lane.batchSize < 1) throw new Error(`lane ${lane.name} has invalid batch size`);
  if (lane.seed.kind === "seq" && (!Number.isSafeInteger(lane.seed.seq) || lane.seed.seq < 0)) {
    throw new Error(`lane ${lane.name} has invalid sequence seed`);
  }
};

export class PostgresJournalConsumerStore implements JournalConsumerStore {
  readonly #schema: string;
  constructor(private readonly sql: SQL, serviceSchema: string) {
    this.#schema = identifier(serviceSchema, "serviceSchema");
  }

  async initializeLane(lane: JournalLane<any>): Promise<void> {
    validateLane(lane);
    await this.sql.begin(async (transaction) => {
      const headRows = await transaction.unsafe("SELECT committed_seq FROM journal.head WHERE singleton");
      const head = Number(headRows[0]?.committed_seq);
      if (!Number.isSafeInteger(head) || head < 0) throw new Error("journal_head_missing");
      const seed = lane.seed.kind === "beginning" ? 0 : lane.seed.kind === "now" ? head : lane.seed.seq;
      if (seed > head) throw new Error(`lane ${lane.name} seed ${seed} exceeds journal head ${head}`);
      await transaction.unsafe(
        `INSERT INTO ${this.#schema}.journal_cursors
          (lane, cursor_seq, predicate_hash, seed_kind, seed_seq)
         VALUES ($1, $2, $3, $4, $2)
         ON CONFLICT (lane) DO NOTHING`,
        [lane.name, seed, lane.predicateHash, lane.seed.kind],
      );
      const rows = await transaction.unsafe(
        `SELECT cursor_seq, predicate_hash, seed_kind, seed_seq
         FROM ${this.#schema}.journal_cursors WHERE lane = $1 FOR UPDATE`,
        [lane.name],
      );
      const row = rows[0];
      if (!row) throw new Error(`lane ${lane.name} cursor missing after initialization`);
      if (row.predicate_hash !== lane.predicateHash) throw new Error(`lane ${lane.name} predicate hash mismatch`);
      const storedSeed = Number(row.seed_seq);
      if (row.seed_kind !== lane.seed.kind
        || !Number.isSafeInteger(storedSeed)
        || (lane.seed.kind === "beginning" && storedSeed !== 0)
        || (lane.seed.kind === "seq" && storedSeed !== lane.seed.seq)
        || (lane.seed.kind === "now" && (storedSeed < 0 || storedSeed > head))) {
        throw new Error(`lane ${lane.name} seed declaration mismatch`);
      }
    });
  }

  async drainLane(lane: JournalLane<any>): Promise<DrainResult> {
    validateLane(lane);
    const appliedEvents: unknown[] = [];
    const result = await this.sql.begin(async (transaction) => {
      const cursorRows = await transaction.unsafe(
        `SELECT cursor_seq FROM ${this.#schema}.journal_cursors WHERE lane = $1 FOR UPDATE`,
        [lane.name],
      );
      if (!cursorRows[0]) throw new Error(`lane ${lane.name} is not initialized`);
      const cursor = Number(cursorRows[0].cursor_seq);
      const headRows = await transaction.unsafe("SELECT committed_seq FROM journal.head WHERE singleton");
      const frontier = Number(headRows[0]?.committed_seq);
      if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(frontier)) throw new Error("invalid journal cursor frontier");
      if (cursor >= frontier) return { cursor, frontier, inspected: 0, applied: 0, poisoned: 0 };

      const exact = [...(lane.predicate.exact ?? [])];
      const prefixes = [...(lane.predicate.prefixes ?? [])];
      const clauses: string[] = [];
      const values: unknown[] = [cursor, frontier];
      if (exact.length > 0) {
        const placeholders = exact.map((eventType) => {
          values.push(eventType);
          return `$${values.length}`;
        });
        clauses.push(`event_type IN (${placeholders.join(", ")})`);
      }
      for (const prefix of prefixes) {
        values.push(prefix);
        clauses.push(`left(event_type, length($${values.length}) + 1) = $${values.length} || '.'`);
      }
      values.push(lane.batchSize);
      const events = await transaction.unsafe(
        `SELECT seq, event_id::text, event_type, schema_version, producer,
                producer_role::text, estate, placement, occurred_at, recorded_at,
                payload, provenance, stream_id::text, stream_seq,
                causation_event_id::text, correlation_id::text
         FROM journal.events
         WHERE seq > $1 AND seq <= $2 AND (${clauses.join(" OR ")})
         ORDER BY seq
         LIMIT $${values.length}`,
        values,
      ) as unknown as JournalEvent[];

      let applied = 0;
      let poisoned = 0;
      for (const event of events) {
        let decoded: unknown;
        try {
          decoded = lane.decode(event);
        } catch (error) {
          if (!(error instanceof PoisonEventError)) throw error;
          await transaction.unsafe(
            `INSERT INTO ${this.#schema}.journal_poison
              (lane, event_seq, event_id, event_type, schema_version, error_code, detail)
             VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)
             ON CONFLICT (lane, event_seq) DO NOTHING`,
            [lane.name, event.seq, event.event_id, event.event_type, event.schema_version, error.code, error.detail],
          );
          poisoned += 1;
          continue;
        }
        await transaction.unsafe("SAVEPOINT journal_lane_handle");
        try {
          await lane.handle(transaction, decoded);
          await transaction.unsafe("RELEASE SAVEPOINT journal_lane_handle");
        } catch (error) {
          if (!(error instanceof PoisonEventError)) throw error;
          await transaction.unsafe("ROLLBACK TO SAVEPOINT journal_lane_handle");
          await transaction.unsafe("RELEASE SAVEPOINT journal_lane_handle");
          await transaction.unsafe(
            `INSERT INTO ${this.#schema}.journal_poison
              (lane, event_seq, event_id, event_type, schema_version, error_code, detail)
             VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)
             ON CONFLICT (lane, event_seq) DO NOTHING`,
            [lane.name, event.seq, event.event_id, event.event_type, event.schema_version, error.code, error.detail],
          );
          poisoned += 1;
          continue;
        }
        appliedEvents.push(decoded);
        applied += 1;
      }

      const nextCursor = events.length < lane.batchSize ? frontier : Number(events.at(-1)!.seq);
      await transaction.unsafe(
        `UPDATE ${this.#schema}.journal_cursors
         SET cursor_seq = $2, advanced_at = clock_timestamp()
         WHERE lane = $1`,
        [lane.name, nextCursor],
      );
      return { cursor: nextCursor, frontier, inspected: events.length, applied, poisoned };
    });
    if (lane.afterCommit && appliedEvents.length > 0) await lane.afterCommit(appliedEvents);
    return result;
  }
}

// The consumer treats decoded lane values as opaque; `any` exists only to
// accommodate variance between independently typed lane handlers.
type AnyJournalLane = JournalLane<any>;

export class DurableJournalConsumer {
  readonly #lanes: readonly AnyJournalLane[];
  readonly #store: JournalConsumerStore;
  #drainRequested = false;
  #drainRunning = false;
  #activeDrain: Promise<void> | undefined;
  #laneState: Record<string, DrainResult> = {};

  constructor(options: { lanes: readonly AnyJournalLane[]; store: JournalConsumerStore }) {
    if (options.lanes.length === 0) throw new Error("durable consumer requires at least one lane");
    const names = new Set<string>();
    for (const lane of options.lanes) {
      validateLane(lane);
      if (names.has(lane.name)) throw new Error(`duplicate journal lane: ${lane.name}`);
      names.add(lane.name);
    }
    this.#lanes = options.lanes;
    this.#store = options.store;
  }

  async initialize(): Promise<void> {
    for (const lane of this.#lanes) await this.#store.initializeLane(lane);
  }

  requestDrain(): Promise<void> {
    this.#drainRequested = true;
    if (!this.#activeDrain) this.#activeDrain = this.#drain();
    return this.#activeDrain;
  }

  async settle(): Promise<void> {
    await this.#activeDrain;
  }

  inspect(): { drainRequested: boolean; drainRunning: boolean; lanes: Record<string, DrainResult> } {
    return { drainRequested: this.#drainRequested, drainRunning: this.#drainRunning, lanes: structuredClone(this.#laneState) };
  }

  async #drain(): Promise<void> {
    this.#drainRunning = true;
    try {
      while (this.#drainRequested) {
        this.#drainRequested = false;
        for (const lane of this.#lanes) {
          let result: DrainResult;
          do {
            result = await this.#store.drainLane(lane);
            this.#laneState[lane.name] = result;
          } while (result.cursor < result.frontier);
        }
      }
    } finally {
      this.#drainRunning = false;
      this.#activeDrain = undefined;
    }
    if (this.#drainRequested) await this.requestDrain();
  }
}
