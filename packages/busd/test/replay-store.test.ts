import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { DbEndpoint, connectDb, type DbEndpointT } from "@terminus-os/db";
import type { ReplayAdmission, ReplayEventInput } from "@terminus-os/contracts";
import {
  IdempotencyConflict,
  MemoryReplayStore,
  PostgresReplayStore,
  foldReplay,
} from "../src/replay-store.ts";

const replayId = "d9428888-122b-4c26-b269-0a3f62f4f06b";
const firstEventId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function event(over: Partial<ReplayEventInput> = {}): ReplayEventInput {
  return {
    replay_id: replayId,
    event_id: firstEventId,
    event_type: "githubd.command_accepted",
    schema_version: 1,
    source: "githubd",
    provenance: { machine: "test", ingress: "command" },
    causation_event_id: null,
    occurred_at: "2026-07-26T17:00:00.000Z",
    payload: { repository: "token-fleet" },
    ...over,
  };
}

function admission(over: Partial<ReplayAdmission> = {}): ReplayAdmission {
  return {
    replay_id: replayId,
    request_hash: "a".repeat(64),
    event: event(),
    ...over,
  };
}

describe("MemoryReplayStore", () => {
  test("first admission binds the request hash and identical admission is idempotent", async () => {
    const store = new MemoryReplayStore(() => "2026-07-26T17:01:00.000Z");
    const first = await store.admit(admission());
    const repeated = await store.admit(admission({
      event: event({ event_id: "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1" }),
    }));
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.event).toEqual(first.event);
    expect((await store.projection(replayId))?.events).toHaveLength(1);
  });

  test("changed request under one replay refuses before another event exists", async () => {
    const store = new MemoryReplayStore();
    await store.admit(admission());
    await expect(store.admit(admission({ request_hash: "b".repeat(64) })))
      .rejects.toBeInstanceOf(IdempotencyConflict);
    expect((await store.projection(replayId))?.events).toHaveLength(1);
  });

  test("append assigns per-replay sequence and event identity is idempotent", async () => {
    const store = new MemoryReplayStore();
    await store.admit(admission());
    const input = event({
      event_id: "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1",
      event_type: "githubd.command_completed",
      causation_event_id: firstEventId,
      payload: { terminal: true, outcome: "succeeded" },
    });
    const appended = await store.append(input);
    const repeated = await store.append(input);
    expect(appended).toMatchObject({ created: true, event: { sequence: 2 } });
    expect(repeated).toMatchObject({ created: false, event: { sequence: 2 } });
    expect((await store.projection(replayId))?.terminal).toBe(true);
  });

  test("projection rebuild is a pure fold and delivery attempts are rebuildable", async () => {
    const store = new MemoryReplayStore();
    store.setSubscription({
      name: "githubd-manager",
      delivery_url: "http://127.0.0.1:7999/event",
      event_pattern: "githubd.%",
      active: true,
    });
    const accepted = await store.admit(admission());
    await store.recordDelivery(accepted.event.event_id, "githubd-manager", false, "offline");
    await store.recordDelivery(accepted.event.event_id, "githubd-manager", true, null);
    const projection = await store.projection(replayId);
    expect(projection?.deliveries).toEqual([{
      event_id: firstEventId,
      subscription: "githubd-manager",
      status: "delivered",
      attempts: 2,
      last_error: null,
    }]);
    expect(foldReplay(
      replayId,
      "a".repeat(64),
      "githubd",
      projection!.events,
      projection!.deliveries,
    )).toEqual(projection!);
  });

  test("unfinished lookup survives a lost wake and duplicate wakes do not duplicate effects", async () => {
    const store = new MemoryReplayStore();
    store.setSubscription({
      name: "manager",
      delivery_url: "http://127.0.0.1:7999/event",
      event_pattern: "githubd.%",
      active: true,
    });
    await store.admit(admission());
    await store.append(event({
      event_id: "9e107d9d-372b-4f4f-9b9d-64a3f5f6b8c1",
      event_type: "githubd.command_progressed",
      causation_event_id: firstEventId,
    }));
    expect(await store.unfinished("githubd")).toEqual([replayId]);
    expect((await store.pendingDeliveries(10)).map((task) => task.event.sequence)).toEqual([1]);
    expect((await store.pendingDeliveries(10)).map((task) => task.event.sequence)).toEqual([1]);
    await store.recordDelivery(firstEventId, "manager", true, null);
    expect((await store.pendingDeliveries(10)).map((task) => task.event.sequence)).toEqual([2]);
  });
});

function endpointFromTestEnv(env: Record<string, string | undefined>): DbEndpointT | null {
  if (env.TERMINUS_DB_TEST_SOCKET_DIR) {
    return DbEndpoint.parse({
      kind: "socket",
      socket_dir: env.TERMINUS_DB_TEST_SOCKET_DIR,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? "postgres",
      application_name: "replay-store-integration",
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: "tcp",
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? "postgres",
      username: env.TERMINUS_DB_TEST_USERNAME ?? "postgres",
      application_name: "replay-store-integration",
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn("[busd] replay integration lane SKIPPED — set the fleet or CI PostgreSQL 18 test endpoint");
}

describe.skipIf(!endpoint)("PostgresReplayStore (live PostgreSQL 18)", () => {
  let raw: SQL;
  let store: PostgresReplayStore;
  const pgReplayId = crypto.randomUUID();
  const pgFirstEventId = crypto.randomUUID();

  beforeAll(async () => {
    store = await PostgresReplayStore.connect(endpoint!, () => "2026-07-26T17:01:00.000Z");
    raw = await connectDb(endpoint!);
    await raw`
      INSERT INTO bus.subscriptions (name, delivery_url, event_pattern, active)
      VALUES ('replay-test-manager', 'http://127.0.0.1:7999/event', 'githubd.%', true)
      ON CONFLICT (name) DO UPDATE SET active = true`;
  });

  afterAll(async () => {
    await store?.close();
    await raw?.close();
  });

  test("admission, append, atomic publication, projection rebuild, and immutability hold in PostgreSQL", async () => {
    const pgAdmission: ReplayAdmission = {
      ...admission(),
      replay_id: pgReplayId,
      event: event({ replay_id: pgReplayId, event_id: pgFirstEventId, source: `githubd-integration-${pgReplayId}` }),
    };
    const accepted = await store.admit(pgAdmission);
    expect(accepted.created).toBe(true);
    await expect(store.admit({ ...pgAdmission, request_hash: "b".repeat(64) }))
      .rejects.toBeInstanceOf(IdempotencyConflict);
    await store.append(event({
      replay_id: pgReplayId,
      event_id: crypto.randomUUID(),
      event_type: "githubd.command_completed",
      source: `githubd-integration-${pgReplayId}`,
      causation_event_id: pgFirstEventId,
      payload: { terminal: true, outcome: "succeeded" },
    }));
    const counts = (await raw`
      SELECT
        (SELECT count(*)::int FROM replay.events WHERE replay_id = ${pgReplayId}) AS events,
        (SELECT count(*)::int FROM replay.publication_intents i
          JOIN replay.events e ON e.event_id = i.event_id
          WHERE e.replay_id = ${pgReplayId}) AS intents`) as { events: number; intents: number }[];
    expect(counts[0]).toEqual({ events: 2, intents: 2 });
    const pending = (await store.pendingDeliveries(100))
      .filter((task) => task.event.replay_id === pgReplayId && task.subscription === "replay-test-manager");
    expect(pending.map((task) => task.event.sequence)).toEqual([1]);
    await store.recordDelivery(pending[0]!.event.event_id, "replay-test-manager", true, null);
    const next = (await store.pendingDeliveries(100))
      .filter((task) => task.event.replay_id === pgReplayId && task.subscription === "replay-test-manager");
    expect(next.map((task) => task.event.sequence)).toEqual([2]);
    const projection = await store.projection(pgReplayId);
    expect(projection?.terminal).toBe(true);
    const firstPage = await store.events({
      after: null,
      source: `githubd-integration-${pgReplayId}`,
      eventTypePrefix: "githubd.",
      limit: 1,
    });
    expect(firstPage.events.map((item) => item.sequence)).toEqual([1]);
    expect(firstPage.next_cursor).toBe(pgFirstEventId);
    expect((await store.events({
      after: firstPage.next_cursor,
      source: `githubd-integration-${pgReplayId}`,
      eventTypePrefix: "githubd.",
      limit: 10,
    })).events.map((item) => item.sequence)).toEqual([2]);
    expect(projection?.deliveries.find((delivery) =>
      delivery.event_id === pending[0]!.event.event_id && delivery.subscription === "replay-test-manager"))
      .toMatchObject({ status: "delivered", attempts: 1 });
    const concurrentEvent = event({
      replay_id: pgReplayId,
      event_id: crypto.randomUUID(),
      event_type: "githubd.delivery_observed",
      source: `githubd-integration-${pgReplayId}`,
      causation_event_id: pgFirstEventId,
      payload: { observation: "duplicate-wakeup" },
    });
    const concurrent = await Promise.all([store.append(concurrentEvent), store.append(concurrentEvent)]);
    expect(concurrent.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(concurrent.map((result) => result.event.sequence))).toEqual(new Set([3]));
    const driven = async (query: PromiseLike<unknown>): Promise<void> => {
      await query;
    };
    await expect(driven(raw`UPDATE replay.events SET source = 'tampered' WHERE replay_id = ${pgReplayId}`))
      .rejects.toThrow(/append-only/);
    await expect(driven(raw`DELETE FROM replay.streams WHERE replay_id = ${pgReplayId}`))
      .rejects.toThrow(/append-only/);
    await expect(driven(raw`TRUNCATE replay.publication_intents`))
      .rejects.toThrow(/append-only/);
    await expect(driven(raw`
      INSERT INTO replay.events (
        event_id, replay_id, sequence, event_type, schema_version, source,
        provenance, causation_event_id, occurred_at, recorded_at, payload
      ) VALUES (
        ${crypto.randomUUID()}, ${pgReplayId}, 99, 'invalid', 1, 'test',
        ${[]}, NULL, 'not-a-time', 'not-a-time', ${[]}
      )`)).rejects.toThrow();
    const wakeTriggers = (await raw`
      SELECT count(*)::int AS count
      FROM pg_trigger
      WHERE tgrelid = 'replay.events'::regclass
        AND tgname = 'replay_event_wakeup'
        AND NOT tgisinternal`) as { count: number }[];
    expect(wakeTriggers[0]?.count).toBe(0);
    for (const [sequence, schemaVersion] of [[0, 1], [99, 2]] as const) {
      await expect(driven(raw`
        INSERT INTO replay.events (
          event_id, replay_id, sequence, event_type, schema_version, source,
          provenance, causation_event_id, occurred_at, recorded_at, payload
        ) VALUES (
          ${crypto.randomUUID()}, ${pgReplayId}, ${sequence}, 'githubd.invalid',
          ${schemaVersion}, 'test', ${{ machine: "test", ingress: "test" }},
          NULL, '2026-07-26T17:00:00.000Z', '2026-07-26T17:00:00.000Z', ${{}}
        )`)).rejects.toThrow();
    }
  });

  test("publication-intent failure rolls back the stream and event atomically", async () => {
    const rejectedReplayId = crypto.randomUUID();
    const rejectedEventId = crypto.randomUUID();
    await raw`
      CREATE OR REPLACE FUNCTION replay.test_reject_publication() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected publication failure';
      END;
      $$`;
    await raw.unsafe(`
      CREATE TRIGGER replay_test_reject_publication
      BEFORE INSERT ON replay.publication_intents
      FOR EACH ROW
      WHEN (NEW.event_id = '${rejectedEventId}'::uuid)
      EXECUTE FUNCTION replay.test_reject_publication()
    `);
    try {
      await expect(store.admit({
        ...admission(),
        replay_id: rejectedReplayId,
        event: event({ replay_id: rejectedReplayId, event_id: rejectedEventId }),
      })).rejects.toThrow(/injected publication failure/);
      const rows = (await raw`
        SELECT
          (SELECT count(*)::int FROM replay.streams WHERE replay_id = ${rejectedReplayId}) AS streams,
          (SELECT count(*)::int FROM replay.events WHERE replay_id = ${rejectedReplayId}) AS events,
          (SELECT count(*)::int FROM replay.publication_intents WHERE event_id = ${rejectedEventId}) AS intents
      `) as { streams: number; events: number; intents: number }[];
      expect(rows[0]).toEqual({ streams: 0, events: 0, intents: 0 });
    } finally {
      await raw`DROP TRIGGER replay_test_reject_publication ON replay.publication_intents`;
      await raw`DROP FUNCTION replay.test_reject_publication()`;
    }
  });
});
