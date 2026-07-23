// Bus-store tests, two lanes (txd store.test.ts idiom):
//
//  - MemoryBusStore runs unconditionally — the deterministic test seam.
//  - PostgresBusStore runs against a live PostgreSQL 18 when the
//    TERMINUS_DB_TEST_* env is present (fleet dev: socket dir; CI: the
//    postgres:18 service container). Absent the env, the lane skips loudly.
//    The live lane is where LIKE-pattern parity, structural immutability, and
//    the monotonic cursor guard are proven against the real engine.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connectDb, DbEndpoint, type DbEndpointT } from '@terminus-os/db';
import type { BusEventInput } from '@terminus-os/contracts';
import { likeToRegExp, MemoryBusStore, PostgresBusStore } from '../src/store.ts';

function ev(over: Partial<BusEventInput> = {}): BusEventInput {
  return {
    event_type: 'hook.stop',
    source: 'claude',
    payload: { session_id: 's1' },
    provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
    occurred_at: '2026-07-22T00:00:00.000Z',
    ...over,
  };
}

describe('likeToRegExp — the MemoryBusStore matching mirror', () => {
  test('translates %, _ and anchors; escapes regex metacharacters (the dot!)', () => {
    expect(likeToRegExp('hook.%').test('hook.stop')).toBe(true);
    expect(likeToRegExp('hook.%').test('hook.user_prompt_submit')).toBe(true);
    expect(likeToRegExp('hook.%').test('txd.act.stop_reported')).toBe(false);
    // The literal dot must not act as a regex wildcard: `hookXstop` ≠ `hook.stop`.
    expect(likeToRegExp('hook.stop').test('hookXstop')).toBe(false);
    expect(likeToRegExp('hook.st_p').test('hook.stop')).toBe(true);
    expect(likeToRegExp('hook.stop').test('hook.stop_failure')).toBe(false); // anchored
    expect(likeToRegExp('%').test('anything.at_all')).toBe(true);
  });
});

describe('MemoryBusStore', () => {
  test('append assigns monotonic seq and recorded_at; readSince filters by seq and LIKE pattern', async () => {
    let tick = 0;
    const store = new MemoryBusStore(() => `2026-07-22T00:00:0${tick++}.000Z`);
    await store.append(ev());
    await store.append(ev({ event_type: 'hook.notification' }));
    await store.append(ev({ event_type: 'probe.ping' }));
    const all = await store.readSince(0, '%', 10);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all[0]!.recorded_at).toBe('2026-07-22T00:00:00.000Z');
    expect((await store.readSince(0, 'hook.%', 10)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.readSince(1, 'hook.%', 10)).map((e) => e.seq)).toEqual([2]);
    expect((await store.readSince(0, 'hook.%', 1)).map((e) => e.seq)).toEqual([1]); // bounded
    await store.close();
  });

  test('cursor is null until seeded; advanceCursor never regresses', async () => {
    const store = new MemoryBusStore();
    expect(await store.cursor('txd')).toBeNull();
    await store.advanceCursor('txd', 5);
    expect(await store.cursor('txd')).toBe(5);
    await store.advanceCursor('txd', 3); // stale ack — must not regress
    expect(await store.cursor('txd')).toBe(5);
    await store.advanceCursor('txd', 9);
    expect(await store.cursor('txd')).toBe(9);
  });

  test('lag counts only pattern-matching events beyond the cursor', async () => {
    const store = new MemoryBusStore();
    store.setSubscription({ name: 'txd', delivery_url: 'http://127.0.0.1:7781/ingress/bus', event_pattern: 'hook.%', active: true });
    store.setSubscription({ name: 'probe', delivery_url: 'http://127.0.0.1:7999/', event_pattern: 'probe.%', active: false });
    store.seedCursor('txd', 1);
    await store.append(ev());
    await store.append(ev({ event_type: 'hook.notification' }));
    await store.append(ev({ event_type: 'probe.ping' }));
    expect(await store.lag()).toEqual([
      { name: 'probe', active: false, event_pattern: 'probe.%', acked_seq: null, lag: 1 },
      { name: 'txd', active: true, event_pattern: 'hook.%', acked_seq: 1, lag: 1 },
    ]);
    // activeSubscriptions serves only the active set, in name order.
    expect((await store.activeSubscriptions()).map((s) => s.name)).toEqual(['txd']);
  });

  test('append is parse-validated: an undotted event_type is refused', async () => {
    const store = new MemoryBusStore();
    await expect(store.append(ev({ event_type: 'undotted' }))).rejects.toThrow();
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
      application_name: 'busd-store-integration',
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: 'tcp',
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      username: env.TERMINUS_DB_TEST_USERNAME ?? 'postgres',
      application_name: 'busd-store-integration',
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn(
    '[busd] store integration lane SKIPPED — set TERMINUS_DB_TEST_SOCKET_DIR (fleet) or TERMINUS_DB_TEST_HOST (CI) to run it',
  );
}

describe.skipIf(!endpoint)('PostgresBusStore (live postgres 18)', () => {
  let raw: SQL;
  let store: PostgresBusStore;
  let tick = 0;

  beforeAll(async () => {
    raw = await connectDb(endpoint!);
    // Clean slate: connect() re-applies the forward-only migrations from zero.
    await raw`drop schema if exists bus cascade`;
    await raw`drop table if exists schema_migrations`;
    store = await PostgresBusStore.connect(endpoint!, () => `2026-07-22T00:00:0${tick++}.000Z`);
    await raw`insert into bus.subscriptions (name, delivery_url, event_pattern, active)
              values ('txd', 'http://127.0.0.1:7781/ingress/bus', 'hook.%', true)`;
  });

  afterAll(async () => {
    await store?.close();
    await raw?.close();
  });

  test('append assigns monotonic seq; payload/provenance round-trip; occurred_at verbatim', async () => {
    const a = await store.append(ev());
    const b = await store.append(ev({ event_type: 'hook.notification' }));
    const c = await store.append(ev({ event_type: 'probe.ping', source: 'probe' }));
    expect(b.seq).toBe(a.seq + 1);
    expect(c.seq).toBe(b.seq + 1);
    const all = await store.readSince(0, '%', 10);
    expect(all[0]!.payload).toEqual({ session_id: 's1' });
    expect(all[0]!.provenance).toEqual({ ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' });
    expect(all[0]!.occurred_at).toBe('2026-07-22T00:00:00.000Z');
    expect(all[0]!.recorded_at).toBe('2026-07-22T00:00:00.000Z');
  });

  test('jsonb columns hold OBJECTS, not double-encoded JSON strings — the ruled psql surface works', async () => {
    // Regression pin: `JSON.stringify(x)::jsonb` binds an already-encoded
    // parameter and stores jsonb *strings*, killing payload->>'k' in psql.
    const rows = (await raw`
      SELECT jsonb_typeof(payload) AS pay, jsonb_typeof(provenance) AS prov,
             payload->>'session_id' AS sid, provenance->>'ingress' AS ingress
      FROM bus.events ORDER BY seq LIMIT 1`) as { pay: string; prov: string; sid: string | null; ingress: string | null }[];
    expect(rows[0]).toEqual({ pay: 'object', prov: 'object', sid: 's1', ingress: 'hooks' });
  });

  test('LIKE parity: Postgres and the Memory mirror select the same events for the same pattern', async () => {
    for (const pattern of ['hook.%', 'probe.%', '%', 'hook.stop', 'hook.st_p']) {
      const pg = (await store.readSince(0, pattern, 100)).map((e) => e.event_type);
      const match = likeToRegExp(pattern);
      const all = (await store.readSince(0, '%', 100)).map((e) => e.event_type);
      expect(pg).toEqual(all.filter((t) => match.test(t)));
    }
  });

  test('bus.events is structurally append-only (UPDATE/DELETE/TRUNCATE raise)', async () => {
    const driven = async (q: PromiseLike<unknown>) => {
      await q;
    };
    await expect(driven(raw`update bus.events set source = 'x'`)).rejects.toThrow(/append-only/);
    await expect(driven(raw`delete from bus.events`)).rejects.toThrow(/append-only/);
    await expect(driven(raw`truncate bus.events`)).rejects.toThrow(/append-only/);
    expect(await store.count()).toBe(3);
  });

  test('cursor: null until seeded; the ON CONFLICT guard is monotonic', async () => {
    expect(await store.cursor('txd')).toBeNull();
    await store.advanceCursor('txd', 2);
    expect(await store.cursor('txd')).toBe(2);
    await store.advanceCursor('txd', 1); // stale ack — must not regress
    expect(await store.cursor('txd')).toBe(2);
    await store.advanceCursor('txd', 3);
    expect(await store.cursor('txd')).toBe(3);
  });

  test('bus.lag agrees with the cursor and pattern (psql and /ctl/health share this view)', async () => {
    const rows = await store.lag();
    expect(rows).toEqual([
      { name: 'txd', active: true, event_pattern: 'hook.%', acked_seq: 3, lag: 0 },
    ]);
    await raw`insert into bus.subscriptions (name, delivery_url, event_pattern, active)
              values ('probe', 'http://127.0.0.1:7999/', 'probe.%', true)`;
    const withProbe = await store.lag();
    // probe: unseeded cursor (null) with one matching event outstanding.
    expect(withProbe).toEqual([
      { name: 'probe', active: true, event_pattern: 'probe.%', acked_seq: null, lag: 1 },
      { name: 'txd', active: true, event_pattern: 'hook.%', acked_seq: 3, lag: 0 },
    ]);
    expect((await store.activeSubscriptions()).map((s) => s.name)).toEqual(['probe', 'txd']);
  });
});
