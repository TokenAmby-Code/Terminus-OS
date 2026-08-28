// The txd-events journal lane consumes exactly its predicate. A journal event
// type the lane does not handle — however new, and whichever service emits it —
// is never selected, never decoded, never poisoned: the cursor passes it and
// the drain stays healthy. A matched event with an invalid payload is
// quarantined durably in journal_poison and never re-inspected.
//
// Runs against a live PostgreSQL 18 when the TERMINUS_DB_TEST_* env is present
// (fleet dev: socket dir; CI: the postgres:18 service container) — the same
// gating as the store integration lane. Absent the env, the lane skips loudly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connectDb, DbEndpoint, MIGRATIONS_DIR, runMigrations, type DbEndpointT } from '@terminus-os/db';
import { createTxdEventLane } from '../src/event-journal.ts';
import { PostgresJournalConsumerStore } from '../src/journal/durable-consumer.ts';
import type { Daemon } from '../src/core.ts';

function endpointFromTestEnv(env: Record<string, string | undefined>): DbEndpointT | null {
  if (env.TERMINUS_DB_TEST_SOCKET_DIR) {
    return DbEndpoint.parse({
      kind: 'socket',
      socket_dir: env.TERMINUS_DB_TEST_SOCKET_DIR,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      application_name: 'txd-journal-tolerance',
      max: 1,
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: 'tcp',
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      username: env.TERMINUS_DB_TEST_USERNAME ?? 'postgres',
      application_name: 'txd-journal-tolerance',
      max: 1,
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn(
    '[txd] journal tolerance lane SKIPPED — set TERMINUS_DB_TEST_SOCKET_DIR (fleet) or TERMINUS_DB_TEST_HOST (CI) to run it',
  );
}

describe.skipIf(!endpoint)('txd-events journal lane (live postgres 18)', () => {
  let raw: SQL;
  const handled: string[] = [];
  const daemon = {
    dispatch: async () => { handled.push('dispatch'); },
    recordPhysicalDeclaration: async () => { handled.push('physical'); },
    abortRegistration: async () => { handled.push('abort'); },
    activateRegisteredAgent: async () => { handled.push('activate'); },
  } as unknown as Daemon;
  const lane = createTxdEventLane({ machine: 'test-machine', daemon });

  async function plant(eventType: string, payload: Record<string, unknown>): Promise<number> {
    const rows = (await raw`
      INSERT INTO journal.events (event_id, event_type, schema_version, producer, producer_role,
                                  estate, placement, occurred_at, recorded_at, payload, provenance)
      VALUES (gen_random_uuid(), ${eventType}, 1, 'test', 'service', 'test-machine', 'test-machine',
              now(), now(), ${payload}, '{}'::jsonb)
      RETURNING seq`) as { seq: number }[];
    const seq = Number(rows[0]!.seq);
    await raw`UPDATE journal.head SET committed_seq = ${seq} WHERE singleton`;
    return seq;
  }

  beforeAll(async () => {
    raw = await connectDb(endpoint!);
    // Clean slate, then the forward-only migrations from zero.
    await raw`drop schema if exists replay cascade`;
    await raw`drop schema if exists bus cascade`;
    await raw`drop schema if exists telemetry cascade`;
    await raw`drop schema if exists txd cascade`;
    await raw`drop schema if exists journal cascade`;
    await raw`drop table if exists schema_migrations`;
    await runMigrations(raw, MIGRATIONS_DIR);
    // The journal schema belongs to the bus estate, not these migrations —
    // recreate the exact surface the consumer reads.
    await raw`create schema journal`;
    await raw`
      CREATE TABLE journal.events (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id uuid NOT NULL,
        event_type text NOT NULL,
        schema_version integer NOT NULL,
        producer text NOT NULL,
        producer_role text NOT NULL,
        estate text NOT NULL,
        placement text NOT NULL,
        occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        provenance jsonb NOT NULL,
        stream_id uuid,
        stream_seq bigint,
        causation_event_id uuid,
        correlation_id text
      )`;
    await raw`CREATE TABLE journal.head (singleton boolean PRIMARY KEY DEFAULT true, committed_seq bigint NOT NULL)`;
    await raw`INSERT INTO journal.head (singleton, committed_seq) VALUES (true, 0)`;
  });

  afterAll(async () => {
    await raw?.close();
  });

  test('a foreign journal event type is never inspected, never poisoned, and the cursor passes it', async () => {
    const store = new PostgresJournalConsumerStore(raw, 'txd');
    await store.initializeLane(lane);

    const foreignSeq = await plant('githubd.convergence_attested', {
      repository: 'terminus-os',
      candidate_sha: '0000000000000000000000000000000000000000',
    });
    const quarantinedSeq = await plant('agent.registered', { not: 'an agent' });

    const first = await store.drainLane(lane);
    // The foreign row is excluded by the predicate at SQL level: one row
    // inspected (the matched agent.registered), quarantined for its payload.
    expect(first.inspected).toBe(1);
    expect(first.applied).toBe(0);
    expect(first.poisoned).toBe(1);
    expect(first.cursor).toBe(quarantinedSeq);
    expect(first.cursor).toBeGreaterThan(foreignSeq);
    expect(handled).toEqual([]);

    const poison = (await raw`
      SELECT event_seq::int AS seq, event_type, error_code FROM txd.journal_poison ORDER BY event_seq`) as
      { seq: number; event_type: string; error_code: string }[];
    expect(poison).toEqual([{ seq: quarantinedSeq, event_type: 'agent.registered', error_code: 'invalid_registered_agent' }]);

    // The quarantine is durable: nothing is re-inspected, the drain stays healthy.
    const second = await store.drainLane(lane);
    expect(second).toEqual({ cursor: quarantinedSeq, frontier: quarantinedSeq, inspected: 0, applied: 0, poisoned: 0 });
  });
});
