// Event-store tests, two lanes:
//
//  - MemoryEventStore runs unconditionally — the deterministic test seam
//    (FakeTmux's sibling), pinned to the same contract shape.
//  - PostgresEventStore runs against a live PostgreSQL 18 when the
//    TERMINUS_DB_TEST_* env is present (fleet dev: socket dir; CI: the
//    postgres:18 service container) — the same gating as packages/db.
//    Absent the env, the lane skips loudly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connectDb, DbEndpoint, type DbEndpointT } from '@terminus-os/db';
import { MemoryEventStore, PostgresEventStore } from '../src/store.ts';
import type { EventInput } from '@terminus-os/contracts';

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
    const b = await store.append(ev({ event_type: 'reg.bound', payload: { instance_id: 'i', persona: 'p', tint: '#111' } }));
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
      application_name: 'txd-store-integration',
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: 'tcp',
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      username: env.TERMINUS_DB_TEST_USERNAME ?? 'postgres',
      application_name: 'txd-store-integration',
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
    const b = await store.append(ev({ event_type: 'reg.bound', payload: { instance_id: 'i', persona: 'p', tint: '#111' } }));
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
    // Regression pin (busd #34 mirrored): `JSON.stringify(x)::jsonb` binds an
    // already-encoded parameter and stores jsonb *strings*, killing payload->>'k' in psql.
    const rows = (await raw`
      SELECT jsonb_typeof(payload) AS pay, jsonb_typeof(provenance) AS prov,
             payload->>'pane_state' AS state, provenance->>'source' AS src
      FROM txd.events ORDER BY seq LIMIT 1`) as { pay: string; prov: string; state: string | null; src: string | null }[];
    expect(rows[0]).toEqual({ pay: 'object', prov: 'object', state: 'live', src: 'wrapper' });
  });

  test('migration 0005 normalizes historical double-encoded string rows in place', async () => {
    // Plant a pre-fix row (jsonb strings, the old stringify::jsonb shape) via
    // raw INSERT — append is allowed; only UPDATE/DELETE/TRUNCATE are fenced.
    await raw`
      INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
      VALUES ('seat', 'legacy:double-encoded', 'reg.pane_created',
              to_jsonb('{"pane_state":"live"}'::text), to_jsonb('{"source":"wrapper"}'::text),
              '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`;
    // Rewind the ledger for 0005 only and reconnect: the runner re-applies it.
    await raw`DELETE FROM schema_migrations WHERE id = 5`;
    const again = await PostgresEventStore.connect(endpoint!);
    await again.close();
    const rows = (await raw`
      SELECT jsonb_typeof(payload) AS pay, jsonb_typeof(provenance) AS prov,
             payload->>'pane_state' AS state
      FROM txd.events WHERE entity_id = 'legacy:double-encoded'`) as { pay: string; prov: string; state: string | null }[];
    expect(rows[0]).toEqual({ pay: 'object', prov: 'object', state: 'live' });
    // The append-only fence is back up after the migration's scoped trigger disable.
    const driven = async (q: PromiseLike<unknown>) => { await q; };
    await expect(driven(raw`update txd.events set entity_id = 'x' where entity_id = 'legacy:double-encoded'`)).rejects.toThrow(/append-only/);
  });
});
