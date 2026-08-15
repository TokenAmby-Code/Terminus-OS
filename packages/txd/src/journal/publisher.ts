import type { SQL } from "bun";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PRODUCER = /^[a-z][a-z0-9_-]*$/;
const INPUT_KEYS = new Set([
  "eventId", "eventType", "schemaVersion", "idempotencyKey", "occurredAt", "payload",
  "streamId", "streamSeq", "causationEventId", "correlationId", "provenance",
]);

export type JournalPublication = {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  streamId?: string | null;
  streamSeq?: number | null;
  causationEventId?: string | null;
  correlationId?: string | null;
  provenance?: Record<string, unknown>;
};

export type JournalPublishReceipt = {
  seq: number;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  recordedAt: string;
  duplicate: boolean;
};

type PublisherSql = Pick<SQL, "begin">;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function uuid(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`invalid ${field}`);
  return value.toLowerCase();
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !/([zZ]|[+-]\d{2}:?\d{2})$/.test(value)) throw new Error(`invalid ${field}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid ${field}`);
  return parsed.toISOString();
}

function validatePublication(value: JournalPublication): Required<JournalPublication> {
  if (!object(value)) throw new Error("publication must be an object");
  for (const key of Object.keys(value)) if (!INPUT_KEYS.has(key)) throw new Error(`unknown publication field: ${key}`);
  if (!EVENT_TYPE.test(value.eventType)) throw new Error("invalid eventType");
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error("invalid schemaVersion");
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length === 0) throw new Error("invalid idempotencyKey");
  if (!object(value.payload)) throw new Error("payload must be an object");
  if (value.provenance !== undefined && !object(value.provenance)) throw new Error("provenance must be an object");
  const streamId = uuid(value.streamId, "streamId", true);
  const streamSeq = value.streamSeq ?? null;
  if ((streamId === null) !== (streamSeq === null)) throw new Error("streamId and streamSeq must be supplied together");
  if (streamSeq !== null && (!Number.isSafeInteger(streamSeq) || streamSeq < 1)) throw new Error("invalid streamSeq");
  return {
    eventId: uuid(value.eventId, "eventId")!,
    eventType: value.eventType,
    schemaVersion: value.schemaVersion,
    idempotencyKey: value.idempotencyKey,
    occurredAt: timestamp(value.occurredAt, "occurredAt"),
    payload: value.payload,
    streamId,
    streamSeq,
    causationEventId: uuid(value.causationEventId, "causationEventId", true),
    correlationId: uuid(value.correlationId, "correlationId", true),
    provenance: value.provenance ?? {},
  };
}

function receipt(row: Record<string, unknown>, expected: Required<JournalPublication>): JournalPublishReceipt {
  const seq = Number(row.seq);
  const recordedAt = row.recorded_at instanceof Date
    ? row.recorded_at.toISOString()
    : timestamp(row.recorded_at, "receipt.recorded_at");
  if (!Number.isSafeInteger(seq) || seq < 1
    || uuid(row.event_id, "receipt.event_id") !== expected.eventId
    || row.event_type !== expected.eventType
    || row.schema_version !== expected.schemaVersion
    || typeof row.duplicate !== "boolean") {
    throw new Error("journal.publish returned an invalid receipt");
  }
  return {
    seq,
    eventId: expected.eventId,
    eventType: expected.eventType,
    schemaVersion: expected.schemaVersion,
    recordedAt,
    duplicate: row.duplicate,
  };
}

export class PostgresJournalPublisher {
  constructor(private readonly sql: PublisherSql, private readonly producer: string) {
    if (!PRODUCER.test(producer)) throw new Error("invalid journal producer");
  }

  async publish(input: JournalPublication): Promise<JournalPublishReceipt> {
    const event = validatePublication(input);
    return await this.sql.begin(async (transaction) => {
      const rows = await transaction.unsafe(
        `SELECT seq, event_id::text, event_type, schema_version, recorded_at, duplicate
         FROM journal.publish(
           $1::text, $2::uuid, $3::text, $4::integer, $5::text, $6::timestamptz, $7::jsonb,
           $8::uuid, $9::bigint, $10::uuid, $11::uuid, $12::jsonb
         )`,
        [
          this.producer, event.eventId, event.eventType, event.schemaVersion, event.idempotencyKey,
          event.occurredAt, JSON.stringify(event.payload), event.streamId, event.streamSeq,
          event.causationEventId, event.correlationId, JSON.stringify(event.provenance),
        ],
      ) as Array<Record<string, unknown>>;
      if (rows.length !== 1) throw new Error("journal.publish returned an invalid receipt count");
      return receipt(rows[0]!, event);
    });
  }
}
