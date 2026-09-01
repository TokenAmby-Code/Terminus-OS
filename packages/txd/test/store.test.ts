// Event-store tests, two lanes:
//
//  - MemoryEventStore runs unconditionally — the deterministic test seam
//    (FakeTmux's sibling), pinned to the same contract shape.
//  - PostgresEventStore runs against a live PostgreSQL 18 when the
//    TERMINUS_DB_TEST_* env is present (fleet dev: socket dir; CI: the
//    postgres:18 service container) — the repository's PostgreSQL integration gate.
//    Absent the env, the lane skips loudly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connectDb, DbEndpoint, type DbEndpointT } from '@tokenamby-code/stc-contract/pg';
import { MemoryEventStore, PostgresEventStore } from '../src/store.ts';
import { EVENT_TYPES, type EventInput } from '@terminus-os/contracts';
import { buildProjections } from '../src/projections.ts';

function ev(over: Partial<EventInput> = {}): EventInput {
  return {
    entity_type: 'seat',
    entity_id: 'somnium:NE',
    event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'wrapper', transport_receipt: 'edge_proxy', emitter_version: 1 },
    occurred_at: '2026-07-12T00:00:00.000Z',
    ...over,
  };
}

describe('MemoryEventStore', () => {
  test('append assigns monotonic seq and a daemon recorded_at', async () => {
    let tick = 0;
    const store = new MemoryEventStore(() => `2026-07-12T00:00:0${tick++}.000Z`);
    const a = await store.append(ev());
    const b = await store.append(ev({ event_type: 'reg.bound', payload: { agent_id: 'i', persona: 'p', tint: '#111' } }));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.recorded_at).toBe('2026-07-12T00:00:00.000Z');
    expect(b.recorded_at).toBe('2026-07-12T00:00:01.000Z');
    expect(await store.count()).toBe(2);
    await store.close();
  });

  test('readByEntity returns only that entity in seq order', async () => {
    const store = new MemoryEventStore();
    await store.append(ev({ entity_id: 'seatA' }));
    await store.append(ev({ entity_id: 'seatB' }));
    await store.append(ev({ entity_id: 'seatA', event_type: 'reg.seat_cleared', payload: {} }));
    const a = await store.readByEntity('seatA');
    expect(a.map((e) => e.event_type)).toEqual(['reg.pane_created', 'reg.seat_cleared']);
    expect(a.every((e) => e.entity_id === 'seatA')).toBe(true);
    await store.close();
  });

  test('provenance round-trips as structured JSON', async () => {
    const store = new MemoryEventStore();
    const rec = await store.append(ev());
    const back = (await store.readAll())[0]!;
    expect(back.provenance).toEqual({ source: 'wrapper', transport_receipt: 'edge_proxy', emitter_version: 1 });
    expect(rec.provenance.source).toBe('wrapper');
    await store.close();
  });

  test('appendAll validates the whole batch before committing any of it', async () => {
    const store = new MemoryEventStore();
    const bad = { ...ev(), entity_type: 'nonsense' } as unknown as EventInput;
    await expect(store.appendAll([ev(), bad])).rejects.toThrow();
    expect(await store.count()).toBe(0);
    await store.close();
  });

  test('persistence membrane rejects raw tmux ids in entities, payload keys and values, and provenance', async () => {
    const store = new MemoryEventStore();
    const attacks = [
      ev({ entity_id: 'seat %1' }),
      ev({ payload: { nested: { pane: '@2' } } }),
      ev({ payload: { '$3': 'value' } }),
      ev({ provenance: { source: 'wrapper', transport_receipt: 'pane %4', emitter_version: 3 } }),
    ];
    for (const attack of attacks) await expect(store.append(attack)).rejects.toThrow(/canonical-id breach/);
    await expect(store.appendAll([ev(), attacks[0]!])).rejects.toThrow(/canonical-id breach/);
    expect(await store.count()).toBe(0);
  });
});

function endpointFromTestEnv(env: Record<string, string | undefined>): DbEndpointT | null {
  if (env.TERMINUS_DB_TEST_SOCKET_DIR) {
    return DbEndpoint.parse({
      kind: 'socket',
      socket_dir: env.TERMINUS_DB_TEST_SOCKET_DIR,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      schema: 'public',
      application_name: 'txd-store-integration',
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
      security: { mode: 'trust' },
      schema: 'public',
      application_name: 'txd-store-integration',
      max: 1,
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn(
    '[txd] store integration lane SKIPPED — set TERMINUS_DB_TEST_SOCKET_DIR (fleet) or TERMINUS_DB_TEST_HOST (CI) to run it',
  );
}

describe.skipIf(!endpoint)('PostgresEventStore (live postgres 18)', () => {
  let raw: SQL;
  let store: PostgresEventStore;
  let tick = 0;

  beforeAll(async () => {
    raw = await connectDb(endpoint!);
    // Clean slate: connect() re-applies the forward-only migrations from zero.
    await raw`drop schema if exists replay cascade`;
    await raw`drop schema if exists bus cascade`;
    await raw`drop schema if exists telemetry cascade`;
    await raw`drop schema if exists journal cascade`;
    await raw`drop schema if exists txd cascade`;
    await raw`drop table if exists schema_migrations`;
    store = await PostgresEventStore.connect(endpoint!, () => `2026-07-12T00:00:0${tick++}.000Z`);
  });

  afterAll(async () => {
    await store?.close();
    await raw?.close();
  });

  test('connect migrates a pristine database and append assigns monotonic seq + recorded_at', async () => {
    const a = await store.append(ev());
    const b = await store.append(ev({ event_type: 'reg.bound', payload: { agent_id: 'i', persona: 'p', tint: '#111' } }));
    expect(b.seq).toBe(a.seq + 1);
    expect(a.recorded_at).toBe('2026-07-12T00:00:00.000Z');
    expect(b.recorded_at).toBe('2026-07-12T00:00:01.000Z');
    expect(await store.count()).toBe(2);
  });

  test('events table is structurally append-only (UPDATE/DELETE/TRUNCATE raise)', async () => {
    // Reach the table via a separate raw handle — the trigger must stop ANY writer.
    // Bun.SQL tagged-template queries are lazy thenables; bun:test's `.rejects`
    // wants a native promise and never drives them (the statement would sit
    // unsent forever). `driven` awaits the query so it actually executes.
    const driven = async (q: PromiseLike<unknown>) => { await q; };
    await expect(driven(raw`update txd.events set entity_id = 'x'`)).rejects.toThrow(/append-only/);
    await expect(driven(raw`delete from txd.events`)).rejects.toThrow(/append-only/);
    await expect(driven(raw`truncate txd.events`)).rejects.toThrow(/append-only/);
    expect(await store.count()).toBe(2);
  });

  test('payload and provenance round-trip as structured JSON; occurred_at is verbatim', async () => {
    const events = await store.readAll();
    const back = events[0]!;
    expect(back.provenance).toEqual({ source: 'wrapper', transport_receipt: 'edge_proxy', emitter_version: 1 });
    expect(back.payload).toEqual({ pane_state: 'live' });
    expect(back.occurred_at).toBe('2026-07-12T00:00:00.000Z');
  });

  test('readByEntity returns only that entity in seq order', async () => {
    await store.append(ev({ entity_id: 'seatA' }));
    await store.append(ev({ entity_id: 'seatB' }));
    await store.append(ev({ entity_id: 'seatA', event_type: 'reg.seat_cleared', payload: {} }));
    const a = await store.readByEntity('seatA');
    expect(a.map((e) => e.event_type)).toEqual(['reg.pane_created', 'reg.seat_cleared']);
    expect(a.every((e) => e.entity_id === 'seatA')).toBe(true);
  });

  test('appendAll is transactional — an invalid event in the batch commits nothing', async () => {
    const before = await store.count();
    const bad = { ...ev(), entity_type: 'nonsense' } as unknown as EventInput;
    await expect(store.appendAll([ev(), bad])).rejects.toThrow();
    expect(await store.count()).toBe(before);
    const ok = await store.appendAll([ev({ entity_id: 'batch:1' }), ev({ entity_id: 'batch:2' })]);
    expect(ok.map((r) => r.entity_id)).toEqual(['batch:1', 'batch:2']);
    expect(await store.count()).toBe(before + 2);
  });

  test('reconnect is idempotent — migrations no-op, the stream persists', async () => {
    const before = await store.count();
    const again = await PostgresEventStore.connect(endpoint!);
    expect(await again.count()).toBe(before);
    await again.close();
  });

  test('jsonb columns hold OBJECTS, not double-encoded JSON strings — the ruled psql surface works', async () => {
    // Regression pin: `JSON.stringify(x)::jsonb` binds an
    // already-encoded parameter and stores jsonb *strings*, killing payload->>'k' in psql.
    const rows = (await raw`
      SELECT jsonb_typeof(payload) AS pay, jsonb_typeof(provenance) AS prov,
             payload->>'pane_state' AS state, provenance->>'source' AS src
      FROM txd.events ORDER BY seq LIMIT 1`) as { pay: string; prov: string; state: string | null; src: string | null }[];
    expect(rows[0]).toEqual({ pay: 'object', prov: 'object', state: 'live', src: 'wrapper' });
  });

  test('comm transport projection recovers from positive bytes and fences prior binding history', async () => {
    const signal = new AbortController().signal;
    const agentId = 'transport-projection-agent';
    const seatId = 'council:transport-projection';
    await store.append(ev({
      entity_type: 'seat', entity_id: seatId, event_type: 'reg.bound', payload: { agent_id: agentId },
    }));
    await store.append(ev({
      entity_type: 'message', entity_id: 'transport-refusal', event_type: 'act.comm_bytes_sent',
      payload: { target_agent_id: agentId, seat_id: seatId, bytes: 0, submit_verdict: 'transport_failed' },
    }));
    expect(await store.unresolvedCommTransportTargets(signal)).toContain(agentId);

    await store.append(ev({
      entity_type: 'message', entity_id: 'transport-recovery', event_type: 'act.comm_bytes_sent',
      payload: { target_agent_id: agentId, seat_id: seatId, bytes: 42, submit_verdict: 'staged' },
    }));
    expect(await store.unresolvedCommTransportTargets(signal)).not.toContain(agentId);

    await store.append(ev({
      entity_type: 'message', entity_id: 'transport-refusal-again', event_type: 'act.comm_bytes_sent',
      payload: { target_agent_id: agentId, seat_id: seatId, bytes: 0, submit_verdict: 'transport_failed' },
    }));
    expect(await store.unresolvedCommTransportTargets(signal)).toContain(agentId);
    await store.append(ev({ entity_type: 'seat', entity_id: seatId, event_type: 'reg.seat_cleared', payload: {} }));
    await store.append(ev({
      entity_type: 'seat', entity_id: seatId, event_type: 'reg.bound', payload: { agent_id: agentId },
    }));
    expect(await store.unresolvedCommTransportTargets(signal)).not.toContain(agentId);
  });

  test('archive-attested compaction records its audit before deleting and preserves replay exactly', async () => {
    await raw`create schema journal`;
    await raw`create table journal.events (seq bigint primary key, recorded_at timestamptz not null)`;
    await raw`insert into journal.events (seq, recorded_at) values (8722, '2026-08-23T14:55:22.201Z')`;
    const rotation = 'rotation:closed';
    await store.append(ev({
      entity_type: 'estate', entity_id: rotation, event_type: 'estate.rotation_requested',
      payload: { force: true }, occurred_at: '2026-08-16T14:10:47.219Z',
    }));
    const completed = await store.append(ev({
      entity_type: 'estate', entity_id: rotation, event_type: 'estate.rotation_completed',
      payload: { canonical_seats: 1 }, occurred_at: '2026-08-16T14:10:48.664Z',
    }));
    await store.append(ev({
      entity_type: 'seat', entity_id: 'current:seat', event_type: 'reg.pane_created',
      payload: { pane_state: 'live' }, occurred_at: '2026-08-17T00:00:00.000Z',
    }));
    const before = await store.readAll();
    const projection = buildProjections(before);
    const attestation = 'snapshot=~/backups/reset-point-2026-08-23;restore-proof=journal.head=8739';

    const result = await store.compact({
      schema_version: 14,
      source_agent_id: 'operator-agent',
      reset_journal_head: 8722,
      archive_attestation: attestation,
    });

    expect(result).toMatchObject({
      ok: true,
      boundary_seq: completed.seq,
      archived_events: before.filter((event) => event.seq <= completed.seq).length,
      reset_journal_head: 8722,
    });
    const after = await store.readAll();
    expect(after[0]).toMatchObject({ seq: completed.seq, event_type: 'estate.compaction_checkpoint' });
    expect(buildProjections(after)).toEqual(projection);
    const audits = (await raw`
      select reset_journal_head::int, boundary_seq::int, archive_attestation, archived_digest
      from txd.event_compactions`) as Array<Record<string, unknown>>;
    expect(audits).toEqual([{
      reset_journal_head: 8722,
      boundary_seq: completed.seq,
      archive_attestation: attestation,
      archived_digest: result.archived_digest,
    }]);
    const driven = async (query: PromiseLike<unknown>) => { await query; };
    await expect(driven(raw`delete from txd.events`)).rejects.toThrow(/append-only/);
  });

  test('migration 0005 normalizes historical double-encoded string rows in place', async () => {
    // Plant a pre-fix row (jsonb strings, the old stringify::jsonb shape) via
    // raw INSERT — append is allowed; only UPDATE/DELETE/TRUNCATE are fenced.
    await raw`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES ('seat', 'legacy:double-encoded', 'reg.pane_created',
              to_jsonb('{"pane_state":"live"}'::text), to_jsonb('{"source":"wrapper"}'::text),
              '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`;
    // Exercise the migration SQL directly. Rewinding a single ledger row below
    // later applied migrations would violate the runner's forward-only
    // contract and is not a valid production state.
    const migration = await Bun.file(
      new URL("../../../migrations/0005_txd_events_jsonb_normalize.sql", import.meta.url),
    ).text();
    await raw.unsafe(migration);
    const rows = (await raw`
      SELECT jsonb_typeof(payload) AS pay, jsonb_typeof(provenance) AS prov,
             payload->>'pane_state' AS state
      FROM txd.events WHERE entity_id = 'legacy:double-encoded'`) as { pay: string; prov: string; state: string | null }[];
    expect(rows[0]).toEqual({ pay: 'object', prov: 'object', state: 'live' });
    // The append-only fence is back up after the migration's scoped trigger disable.
    const driven = async (q: PromiseLike<unknown>) => { await q; };
    await expect(driven(raw`update txd.events set entity_id = 'x' where entity_id = 'legacy:double-encoded'`)).rejects.toThrow(/append-only/);
  });
  test('migration 0022 purges rows outside the admitted event-type union and spares every admitted type', async () => {
    // The purge is a frozen one-time repair: its admitted list is the
    // vocabulary AS OF the migration, read from the migration file itself so
    // this pin cannot drift from what actually ran. Types added later are
    // appended only after migrations, so they never meet this purge — but
    // every type the purge spared must still exist in the contract union
    // (vocabulary only grows; a removal would refuse the surviving rows at
    // boot replay).
    const migrationSql = await Bun.file(
      new URL("../../../migrations/0022_txd_admitted_event_type_purge.sql", import.meta.url),
    ).text();
    const frozenAdmitted = [...migrationSql.matchAll(/'((?:reg|act|estate)\.[a-z_]+)'/g)].map((m) => m[1]!);
    expect(frozenAdmitted.length).toBeGreaterThan(0);
    for (const eventType of frozenAdmitted) expect(EVENT_TYPES as readonly string[]).toContain(eventType);
    // Plant one raw row per frozen admitted type plus one row whose type the
    // union does not admit — append is allowed; only UPDATE/DELETE/TRUNCATE
    // are fenced. Boot replay validates every stored row against the union, so
    // an unadmitted row refuses the whole stream until the purge removes it.
    for (const eventType of frozenAdmitted) {
      await raw`
        INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
        VALUES ('seat', 'purge:admitted', ${eventType},
                '{}'::jsonb, '{"source":"wrapper"}'::jsonb,
                '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`;
    }
    await raw`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES ('seat', 'purge:unadmitted', 'act.retired_transport_probe',
              '{}'::jsonb, '{"source":"wrapper"}'::jsonb,
              '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`;
    // Exercise the migration SQL directly, as the 0005 test does above.
    await raw.unsafe(migrationSql);
    const counts = (await raw`
      SELECT entity_id, count(*)::int AS n FROM txd.events
      WHERE entity_id IN ('purge:unadmitted', 'purge:admitted')
      GROUP BY entity_id ORDER BY entity_id`) as { entity_id: string; n: number }[];
    expect(counts).toEqual([{ entity_id: 'purge:admitted', n: frozenAdmitted.length }]);
    // The append-only fence is back up after the migration's scoped trigger disable.
    const driven = async (q: PromiseLike<unknown>) => { await q; };
    await expect(driven(raw`delete from txd.events where entity_id = 'purge:admitted'`)).rejects.toThrow(/append-only/);
  });
});
