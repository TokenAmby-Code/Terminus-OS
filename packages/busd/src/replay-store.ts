import type { SQL } from "bun";
import { isDeepStrictEqual } from "node:util";
import { connectDb, runMigrations, MIGRATIONS_DIR, type DbEndpointT } from "@terminus-os/db";
import {
  ReplayAdmissionSchema,
  ReplayEventInputSchema,
  ReplayEventRecordSchema,
  type BusSubscriptionRow,
  type ReplayAdmission,
  type ReplayDeliveryStatus,
  type ReplayEventInput,
  type ReplayEventPage,
  type ReplayEventRecord,
  type ReplayProjection,
  type UnfinishedReplayPage,
} from "@terminus-os/contracts";
import { likeToRegExp } from "./store.ts";
import type { DesiredSubscription } from "./config.ts";

export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export class IdempotencyConflict extends Error {}
export class UnknownReplay extends Error {}
export class EventIdentityConflict extends Error {}
export class InvalidEventCursor extends Error {}
export class InvalidReplayCursor extends Error {}
export class UnknownSubscription extends Error {}

export type PublicationTask = {
  subscription: string;
  delivery_url: string;
  event: ReplayEventRecord;
};
export interface ReplayStore {
  admit(input: ReplayAdmission): Promise<{ created: boolean; event: ReplayEventRecord }>;
  append(input: ReplayEventInput): Promise<{ created: boolean; event: ReplayEventRecord }>;
  projection(replayId: string): Promise<ReplayProjection | null>;
  unfinished(query: { source: string; after: string | null; limit: number }): Promise<UnfinishedReplayPage>;
  events(query: {
    after: string | null;
    source: string | null;
    eventTypePrefix: string | null;
    limit: number;
  }): Promise<ReplayEventPage>;
  deliveryAttemptWatermark(): Promise<number>;
  pendingDeliveries(limit: number, attemptWatermark: number): Promise<PublicationTask[]>;
  recordDelivery(eventId: string, subscription: string, succeeded: boolean, error: string | null): Promise<void>;
  close(): Promise<void>;
}

export function foldReplay(
  replayId: string,
  requestHash: string,
  source: string,
  events: ReplayEventRecord[],
  deliveries: ReplayDeliveryStatus[],
): ReplayProjection {
  return {
    replay_id: replayId,
    request_hash: requestHash,
    source,
    terminal: events.some((event) => event.payload.terminal === true),
    events: [...events].sort((left, right) => left.sequence - right.sequence),
    deliveries: [...deliveries].sort((left, right) =>
      left.event_id.localeCompare(right.event_id) || left.subscription.localeCompare(right.subscription)),
  };
}

type Stream = { requestHash: string; source: string; events: ReplayEventRecord[] };
type Attempt = {
  sequence: number;
  eventId: string;
  subscription: string;
  succeeded: boolean;
  error: string | null;
};

export class MemoryReplayStore implements ReplayStore {
  private streams = new Map<string, Stream>();
  private eventIndex = new Map<string, ReplayEventRecord>();
  private journal: ReplayEventRecord[] = [];
  private subscriptions = new Map<string, BusSubscriptionRow>();
  private attempts: Attempt[] = [];

  constructor(private now: Clock = systemClock) {}

  setSubscription(subscription: BusSubscriptionRow): void {
    this.subscriptions.set(subscription.name, subscription);
  }

  async admit(raw: ReplayAdmission): Promise<{ created: boolean; event: ReplayEventRecord }> {
    const input = ReplayAdmissionSchema.parse(raw);
    const existing = this.streams.get(input.replay_id);
    if (existing) {
      if (existing.requestHash !== input.request_hash) {
        throw new IdempotencyConflict("replay_id is already bound to another request");
      }
      return { created: false, event: existing.events[0]! };
    }
    if (this.eventIndex.has(input.event.event_id)) {
      throw new EventIdentityConflict("event_id is already bound to another replay");
    }
    const record = ReplayEventRecordSchema.parse({
      ...input.event,
      sequence: 1,
      recorded_at: this.now(),
    });
    this.streams.set(input.replay_id, {
      requestHash: input.request_hash,
      source: input.event.source,
      events: [record],
    });
    this.eventIndex.set(record.event_id, record);
    this.journal.push(record);
    return { created: true, event: record };
  }

  async append(raw: ReplayEventInput): Promise<{ created: boolean; event: ReplayEventRecord }> {
    const input = ReplayEventInputSchema.parse(raw);
    const stream = this.streams.get(input.replay_id);
    if (!stream) throw new UnknownReplay(`unknown replay_id: ${input.replay_id}`);
    const existing = this.eventIndex.get(input.event_id);
    if (existing) {
      assertSameEvent(existing, input);
      return { created: false, event: existing };
    }
    if (input.causation_event_id && !this.eventIndex.has(input.causation_event_id)) {
      throw new UnknownReplay("causation_event_id does not exist");
    }
    const record = ReplayEventRecordSchema.parse({
      ...input,
      sequence: stream.events.length + 1,
      recorded_at: this.now(),
    });
    stream.events.push(record);
    this.eventIndex.set(record.event_id, record);
    this.journal.push(record);
    return { created: true, event: record };
  }

  async projection(replayId: string): Promise<ReplayProjection | null> {
    const stream = this.streams.get(replayId);
    if (!stream) return null;
    return foldReplay(replayId, stream.requestHash, stream.source, stream.events, this.deliveryProjection(stream.events));
  }

  async unfinished(query: {
    source: string;
    after: string | null;
    limit: number;
  }): Promise<UnfinishedReplayPage> {
    assertLimit(query.limit);
    if (query.after !== null) {
      const cursor = this.streams.get(query.after);
      if (!cursor || cursor.source !== query.source) {
        throw new InvalidReplayCursor("replay cursor does not exist for source");
      }
    }
    const matching = [...this.streams.entries()]
      .filter(([replayId, stream]) =>
        stream.source === query.source
        && (query.after === null || replayId > query.after)
        && !stream.events.some((event) => event.payload.terminal === true))
      .map(([replayId]) => replayId)
      .sort();
    const replays = matching.slice(0, query.limit);
    return {
      replays,
      next_cursor: matching.length > replays.length ? replays.at(-1)! : null,
    };
  }

  async events(query: {
    after: string | null;
    source: string | null;
    eventTypePrefix: string | null;
    limit: number;
  }): Promise<ReplayEventPage> {
    assertLimit(query.limit);
    const cursor = query.after === null
      ? -1
      : this.journal.findIndex((event) => event.event_id === query.after);
    if (query.after !== null && cursor === -1) throw new InvalidEventCursor("event cursor does not exist");
    const matching = this.journal.slice(cursor + 1).filter((event) =>
      (query.source === null || event.source === query.source)
      && (query.eventTypePrefix === null || event.event_type.startsWith(query.eventTypePrefix)));
    const events = matching.slice(0, query.limit);
    return {
      events,
      next_cursor: matching.length > events.length ? events.at(-1)!.event_id : null,
    };
  }

  async deliveryAttemptWatermark(): Promise<number> {
    return this.attempts.length;
  }

  async pendingDeliveries(limit: number, attemptWatermark: number): Promise<PublicationTask[]> {
    assertPositiveLimit(limit);
    const tasks: PublicationTask[] = [];
    for (const stream of this.streams.values()) {
      for (const subscription of this.subscriptions.values()) {
        for (const event of stream.events) {
          if (!subscription.active || !likeToRegExp(subscription.event_pattern).test(event.event_type)) continue;
          const delivered = this.attempts.some((attempt) =>
            attempt.eventId === event.event_id && attempt.subscription === subscription.name && attempt.succeeded);
          const attemptedThisWake = this.attempts.some((attempt) =>
            attempt.sequence > attemptWatermark
            && attempt.eventId === event.event_id
            && attempt.subscription === subscription.name);
          if (!delivered && !attemptedThisWake) {
            tasks.push({ subscription: subscription.name, delivery_url: subscription.delivery_url, event });
          }
          if (!delivered) break;
        }
      }
    }
    return tasks.sort((left, right) =>
      left.event.recorded_at.localeCompare(right.event.recorded_at)
      || left.subscription.localeCompare(right.subscription)).slice(0, limit);
  }

  async recordDelivery(
    eventId: string,
    subscription: string,
    succeeded: boolean,
    error: string | null,
  ): Promise<void> {
    if (!this.eventIndex.has(eventId)) throw new UnknownReplay(`unknown event_id: ${eventId}`);
    if (!this.subscriptions.has(subscription)) throw new UnknownSubscription(`unknown subscription: ${subscription}`);
    this.attempts.push({
      sequence: this.attempts.length + 1,
      eventId,
      subscription,
      succeeded,
      error,
    });
  }

  private deliveryProjection(events: ReplayEventRecord[]): ReplayDeliveryStatus[] {
    const statuses: ReplayDeliveryStatus[] = [];
    for (const event of events) {
      for (const subscription of this.subscriptions.values()) {
        if (!subscription.active || !likeToRegExp(subscription.event_pattern).test(event.event_type)) continue;
        const attempts = this.attempts.filter((attempt) =>
          attempt.eventId === event.event_id && attempt.subscription === subscription.name);
        const latest = attempts.at(-1);
        statuses.push({
          event_id: event.event_id,
          subscription: subscription.name,
          status: latest ? latest.succeeded ? "delivered" : "failed" : "pending",
          attempts: attempts.length,
          last_error: latest?.error ?? null,
        });
      }
    }
    return statuses;
  }

  async close(): Promise<void> {}
}

type EventRow = {
  event_id: string;
  replay_id: string;
  sequence: number | bigint | string;
  event_type: string;
  schema_version: number;
  source: string;
  provenance: unknown;
  causation_event_id: string | null;
  occurred_at: string;
  recorded_at: string;
  payload: unknown;
};

const asJson = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const rowToEvent = (row: EventRow): ReplayEventRecord => ReplayEventRecordSchema.parse({
  event_id: row.event_id,
  replay_id: row.replay_id,
  sequence: Number(row.sequence),
  event_type: row.event_type,
  schema_version: row.schema_version,
  source: row.source,
  provenance: asJson(row.provenance),
  causation_event_id: row.causation_event_id,
  occurred_at: row.occurred_at,
  recorded_at: row.recorded_at,
  payload: asJson(row.payload),
});

export class PostgresReplayStore implements ReplayStore {
  private constructor(private sql: SQL, private now: Clock) {}

  static async connect(endpoint: DbEndpointT, now: Clock = systemClock): Promise<PostgresReplayStore> {
    const sql = await connectDb(endpoint);
    await runMigrations(sql, MIGRATIONS_DIR);
    return new PostgresReplayStore(sql, now);
  }

  async reconcileSubscriptions(desired: DesiredSubscription[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const names = desired.map((subscription) => subscription.name);
      if (names.length) {
        await transaction`
          UPDATE bus.subscriptions
          SET active = false
          WHERE name IN (SELECT subscription_name FROM bus.managed_subscriptions)
            AND name NOT IN ${transaction(names)}`;
      } else {
        await transaction`
          UPDATE bus.subscriptions
          SET active = false
          WHERE name IN (SELECT subscription_name FROM bus.managed_subscriptions)`;
      }
      for (const subscription of desired) {
        await transaction`
          INSERT INTO bus.subscriptions (name, delivery_url, event_pattern, active)
          VALUES (
            ${subscription.name},
            ${subscription.delivery_url},
            ${subscription.event_pattern},
            ${subscription.active}
          )
          ON CONFLICT (name) DO UPDATE SET
            delivery_url = EXCLUDED.delivery_url,
            event_pattern = EXCLUDED.event_pattern,
            active = EXCLUDED.active`;
        await transaction`
          INSERT INTO bus.managed_subscriptions (subscription_name)
          VALUES (${subscription.name})
          ON CONFLICT DO NOTHING`;
        await transaction`
          INSERT INTO bus.cursors (subscription_name, acked_seq)
          SELECT ${subscription.name},
                 CASE WHEN ${subscription.seed} = 'beginning'
                   THEN 0
                   ELSE coalesce(max(seq), 0)
                 END
          FROM bus.events
          ON CONFLICT DO NOTHING`;
      }
    });
  }

  async admit(raw: ReplayAdmission): Promise<{ created: boolean; event: ReplayEventRecord }> {
    const input = ReplayAdmissionSchema.parse(raw);
    try {
      return await this.sql.begin(async (transaction) => {
        const inserted = (await transaction`
        INSERT INTO replay.streams (replay_id, request_hash, source)
        VALUES (${input.replay_id}, ${input.request_hash}, ${input.event.source})
        ON CONFLICT (replay_id) DO NOTHING
        RETURNING replay_id`) as { replay_id: string }[];
        const streams = (await transaction`
        SELECT request_hash, source, next_sequence
        FROM replay.streams WHERE replay_id = ${input.replay_id} FOR UPDATE`) as {
          request_hash: string;
          source: string;
          next_sequence: number | bigint | string;
        }[];
        const stream = streams[0]!;
        if (stream.request_hash.trim() !== input.request_hash) {
          throw new IdempotencyConflict("replay_id is already bound to another request");
        }
        if (inserted.length === 0) {
          const rows = (await transaction`
          SELECT event_id, replay_id, sequence, event_type, schema_version, source,
                 provenance, causation_event_id, occurred_at, recorded_at, payload
          FROM replay.events WHERE replay_id = ${input.replay_id} AND sequence = 1`) as EventRow[];
          return { created: false, event: rowToEvent(rows[0]!) };
        }
        const collision = (await transaction`
          SELECT 1 FROM replay.events WHERE event_id = ${input.event.event_id}`) as { "?column?": number }[];
        if (collision.length) {
          throw new EventIdentityConflict("event_id is already bound to another replay");
        }
        const event = await this.insertEvent(transaction, input.event, 1);
        await transaction`UPDATE replay.streams SET next_sequence = 2 WHERE replay_id = ${input.replay_id}`;
        return { created: true, event };
      }) as { created: boolean; event: ReplayEventRecord };
    } catch (error) {
      normalizeReplayWriteError(error);
    }
  }

  async append(raw: ReplayEventInput): Promise<{ created: boolean; event: ReplayEventRecord }> {
    const input = ReplayEventInputSchema.parse(raw);
    try {
      return await this.sql.begin(async (transaction) => {
        const streams = (await transaction`
        SELECT next_sequence FROM replay.streams
        WHERE replay_id = ${input.replay_id} FOR UPDATE`) as { next_sequence: number | bigint | string }[];
        if (!streams.length) throw new UnknownReplay(`unknown replay_id: ${input.replay_id}`);
        const duplicate = (await transaction`
        SELECT event_id, replay_id, sequence, event_type, schema_version, source,
               provenance, causation_event_id, occurred_at, recorded_at, payload
        FROM replay.events WHERE event_id = ${input.event_id}`) as EventRow[];
        if (duplicate.length) {
          const event = rowToEvent(duplicate[0]!);
          assertSameEvent(event, input);
          return { created: false, event };
        }
        if (input.causation_event_id !== null) {
          const causes = (await transaction`
            SELECT 1 FROM replay.events WHERE event_id = ${input.causation_event_id}`) as { "?column?": number }[];
          if (!causes.length) throw new UnknownReplay("causation_event_id does not exist");
        }
        const sequence = Number(streams[0]!.next_sequence);
        const event = await this.insertEvent(transaction, input, sequence);
        await transaction`
        UPDATE replay.streams SET next_sequence = ${sequence + 1}
        WHERE replay_id = ${input.replay_id}`;
        return { created: true, event };
      }) as { created: boolean; event: ReplayEventRecord };
    } catch (error) {
      normalizeReplayWriteError(error);
    }
  }

  private async insertEvent(transaction: SQL, input: ReplayEventInput, sequence: number): Promise<ReplayEventRecord> {
    const recordedAt = this.now();
    const rows = (await transaction`
      INSERT INTO replay.events (
        event_id, replay_id, sequence, event_type, schema_version, source,
        provenance, causation_event_id, occurred_at, recorded_at, payload
      ) VALUES (
        ${input.event_id}, ${input.replay_id}, ${sequence}, ${input.event_type},
        ${input.schema_version}, ${input.source}, ${input.provenance},
        ${input.causation_event_id}, ${input.occurred_at}, ${recordedAt}, ${input.payload}
        )
      RETURNING event_id, replay_id, sequence, event_type, schema_version, source,
                provenance, causation_event_id, occurred_at, recorded_at, payload`) as EventRow[];
    await transaction`
      INSERT INTO replay.publication_intents (event_id) VALUES (${input.event_id})`;
    return rowToEvent(rows[0]!);
  }

  async projection(replayId: string): Promise<ReplayProjection | null> {
    const streams = (await this.sql`
      SELECT request_hash, source FROM replay.streams WHERE replay_id = ${replayId}`) as {
        request_hash: string;
        source: string;
      }[];
    if (!streams.length) return null;
    const rows = (await this.sql`
      SELECT event_id, replay_id, sequence, event_type, schema_version, source,
             provenance, causation_event_id, occurred_at, recorded_at, payload
      FROM replay.events WHERE replay_id = ${replayId} ORDER BY sequence`) as EventRow[];
    const events = rows.map(rowToEvent);
    const deliveries = await this.deliveryProjection(events);
    return foldReplay(replayId, streams[0]!.request_hash.trim(), streams[0]!.source, events, deliveries);
  }

  async unfinished(query: {
    source: string;
    after: string | null;
    limit: number;
  }): Promise<UnfinishedReplayPage> {
    assertLimit(query.limit);
    if (query.after !== null) {
      const cursor = (await this.sql`
        SELECT 1
        FROM replay.streams
        WHERE replay_id = ${query.after} AND source = ${query.source}`) as { "?column?": number }[];
      if (!cursor.length) throw new InvalidReplayCursor("replay cursor does not exist for source");
    }
    const fetchLimit = query.limit + 1;
    const rows = (await this.sql`
      SELECT s.replay_id::text AS replay_id
      FROM replay.streams s
      WHERE s.source = ${query.source}
        AND (${query.after}::uuid IS NULL OR s.replay_id > ${query.after}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM replay.events e
          WHERE e.replay_id = s.replay_id AND e.payload @> '{"terminal":true}'::jsonb
        )
      ORDER BY s.replay_id
      LIMIT ${fetchLimit}`) as { replay_id: string }[];
    const replays = rows.slice(0, query.limit).map((row) => row.replay_id);
    return {
      replays,
      next_cursor: rows.length > query.limit ? replays.at(-1)! : null,
    };
  }

  async events(query: {
    after: string | null;
    source: string | null;
    eventTypePrefix: string | null;
    limit: number;
  }): Promise<ReplayEventPage> {
    assertLimit(query.limit);
    let cursor = 0;
    if (query.after !== null) {
      const cursors = (await this.sql`
        SELECT journal_sequence
        FROM replay.events
        WHERE event_id = ${query.after}`) as { journal_sequence: number | bigint | string }[];
      if (!cursors.length) throw new InvalidEventCursor("event cursor does not exist");
      cursor = Number(cursors[0]!.journal_sequence);
    }
    const pattern = query.eventTypePrefix === null ? "%" : `${escapeLikePrefix(query.eventTypePrefix)}%`;
    const fetchLimit = query.limit + 1;
    const rows = (await this.sql`
      SELECT event_id, replay_id, sequence, event_type, schema_version, source,
             provenance, causation_event_id, occurred_at, recorded_at, payload
      FROM replay.events
      WHERE journal_sequence > ${cursor}
        AND (${query.source}::text IS NULL OR source = ${query.source})
        AND event_type LIKE ${pattern} ESCAPE '!'
      ORDER BY journal_sequence
      LIMIT ${fetchLimit}`) as EventRow[];
    const events = rows.slice(0, query.limit).map(rowToEvent);
    return {
      events,
      next_cursor: rows.length > query.limit ? events.at(-1)!.event_id : null,
    };
  }

  async deliveryAttemptWatermark(): Promise<number> {
    const rows = (await this.sql`
      SELECT coalesce(max(attempt_sequence), 0)::bigint AS watermark
      FROM replay.delivery_attempts`) as { watermark: number | bigint | string }[];
    return Number(rows[0]!.watermark);
  }

  async pendingDeliveries(limit: number, attemptWatermark: number): Promise<PublicationTask[]> {
    assertPositiveLimit(limit);
    const rows = (await this.sql`
      SELECT s.name AS subscription, s.delivery_url,
             e.event_id, e.replay_id, e.sequence, e.event_type, e.schema_version,
             e.source, e.provenance, e.causation_event_id, e.occurred_at,
             e.recorded_at, e.payload
      FROM replay.publication_intents i
      JOIN replay.events e ON e.event_id = i.event_id
      JOIN bus.subscriptions s ON s.active AND e.event_type LIKE s.event_pattern
      WHERE NOT EXISTS (
        SELECT 1 FROM replay.delivery_attempts a
        WHERE a.event_id = e.event_id
          AND a.subscription_name = s.name
          AND a.succeeded
      )
        AND NOT EXISTS (
          SELECT 1 FROM replay.delivery_attempts current_wake
          WHERE current_wake.event_id = e.event_id
            AND current_wake.subscription_name = s.name
            AND current_wake.attempt_sequence > ${attemptWatermark}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM replay.events prior
          WHERE prior.replay_id = e.replay_id
            AND prior.sequence < e.sequence
            AND prior.event_type LIKE s.event_pattern
            AND NOT EXISTS (
              SELECT 1 FROM replay.delivery_attempts prior_attempt
              WHERE prior_attempt.event_id = prior.event_id
                AND prior_attempt.subscription_name = s.name
                AND prior_attempt.succeeded
            )
      )
      ORDER BY e.journal_sequence, s.name
      LIMIT ${limit}`) as (EventRow & { subscription: string; delivery_url: string })[];
    return rows.map((row) => ({
      subscription: row.subscription,
      delivery_url: row.delivery_url,
      event: rowToEvent(row),
    }));
  }

  async recordDelivery(
    eventId: string,
    subscription: string,
    succeeded: boolean,
    error: string | null,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const events = (await transaction`
        SELECT 1 FROM replay.events WHERE event_id = ${eventId}`) as { "?column?": number }[];
      if (!events.length) throw new UnknownReplay(`unknown event_id: ${eventId}`);
      const subscriptions = (await transaction`
        SELECT 1 FROM bus.subscriptions WHERE name = ${subscription}`) as { "?column?": number }[];
      if (!subscriptions.length) throw new UnknownSubscription(`unknown subscription: ${subscription}`);
      await transaction`
        INSERT INTO replay.delivery_attempts (event_id, subscription_name, succeeded, error)
        VALUES (${eventId}, ${subscription}, ${succeeded}, ${error})`;
    });
  }

  private async deliveryProjection(events: ReplayEventRecord[]): Promise<ReplayDeliveryStatus[]> {
    if (!events.length) return [];
    const eventIds = events.map((event) => event.event_id);
    const rows = (await this.sql`
      SELECT e.event_id::text AS event_id, s.name AS subscription,
             count(a.attempt_sequence)::int AS attempts,
             latest.succeeded, latest.error
      FROM replay.events e
      JOIN bus.subscriptions s ON s.active AND e.event_type LIKE s.event_pattern
      LEFT JOIN replay.delivery_attempts a
        ON a.event_id = e.event_id AND a.subscription_name = s.name
      LEFT JOIN LATERAL (
        SELECT x.succeeded, x.error
        FROM replay.delivery_attempts x
        WHERE x.event_id = e.event_id AND x.subscription_name = s.name
        ORDER BY x.attempt_sequence DESC LIMIT 1
      ) latest ON true
      WHERE e.event_id IN ${this.sql(eventIds)}
      GROUP BY e.event_id, s.name, latest.succeeded, latest.error
      ORDER BY e.event_id, s.name`) as {
        event_id: string;
        subscription: string;
        attempts: number;
        succeeded: boolean | null;
        error: string | null;
      }[];
    return rows.map((row) => ({
      event_id: row.event_id,
      subscription: row.subscription,
      status: row.succeeded === null ? "pending" : row.succeeded ? "delivered" : "failed",
      attempts: row.attempts,
      last_error: row.error,
    }));
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

function assertSameEvent(record: ReplayEventRecord, input: ReplayEventInput): void {
  const comparable = {
    replay_id: record.replay_id,
    event_id: record.event_id,
    event_type: record.event_type,
    schema_version: record.schema_version,
    source: record.source,
    provenance: record.provenance,
    causation_event_id: record.causation_event_id,
    occurred_at: record.occurred_at,
    payload: record.payload,
  };
  if (!isDeepStrictEqual(comparable, input)) {
    throw new EventIdentityConflict("event_id is already bound to different facts");
  }
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
}

function assertLimit(limit: number): void {
  assertPositiveLimit(limit);
  if (limit > 500) throw new RangeError("limit must not exceed 500");
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function normalizeReplayWriteError(error: unknown): never {
  if (error && typeof error === "object") {
    const postgres = error as { errno?: unknown; constraint?: unknown };
    if (postgres.errno === "23505" && postgres.constraint === "events_event_id_key") {
      throw new EventIdentityConflict("event_id is already bound to different facts");
    }
    if (postgres.errno === "23503" && postgres.constraint === "events_causation_event_id_fkey") {
      throw new UnknownReplay("causation_event_id does not exist");
    }
  }
  throw error;
}
