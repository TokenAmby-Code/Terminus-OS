// Behavioral pin: migration 0012 purges historical act.send_* rows so the
// daemon boots clean from a store that once contained them.
//
// The purge is exercised through the exact boot path the daemon uses
// (PostgresEventStore.connect → runMigrations): legacy rows are seeded raw
// (INSERT is not fenced — only UPDATE/DELETE/TRUNCATE are), the 0012 ledger
// row is cleared so the migration re-applies, and connect() must then purge
// exactly those rows, leave every other row byte-identical at its original
// seq, and replay the survivors without error.
//
// Same env gating as store.test.ts / packages/db: fleet dev socket dir or CI
// TCP endpoint; absent the env, the lane skips loudly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connectDb, DbEndpoint, type DbEndpointT } from '@terminus-os/db';
import { PostgresEventStore } from '../src/store.ts';
import { buildProjections } from '../src/projections.ts';

function endpointFromTestEnv(env: Record<string, string | undefined>): DbEndpointT | null {
  if (env.TERMINUS_DB_TEST_SOCKET_DIR) {
    return DbEndpoint.parse({
      kind: 'socket',
      socket_dir: env.TERMINUS_DB_TEST_SOCKET_DIR,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      application_name: 'txd-send-purge-integration',
    });
  }
  if (env.TERMINUS_DB_TEST_HOST) {
    return DbEndpoint.parse({
      kind: 'tcp',
      host: env.TERMINUS_DB_TEST_HOST,
      port: env.TERMINUS_DB_TEST_PORT ? Number(env.TERMINUS_DB_TEST_PORT) : undefined,
      database: env.TERMINUS_DB_TEST_DATABASE ?? 'postgres',
      username: env.TERMINUS_DB_TEST_USERNAME ?? 'postgres',
      application_name: 'txd-send-purge-integration',
    });
  }
  return null;
}

const endpoint = endpointFromTestEnv(Bun.env);
if (!endpoint) {
  console.warn(
    '[txd] send-purge integration lane SKIPPED — set TERMINUS_DB_TEST_SOCKET_DIR (fleet) or TERMINUS_DB_TEST_HOST (CI) to run it',
  );
}

const LEGACY_SEND_ROWS = [
  ['send', 'legacy-send-1', 'act.send_enqueued', { target: 'palace:W', text_len: 2 }],
  ['send', 'legacy-send-1', 'act.send_gated', { target: 'palace:W', reason: 'typing_guard' }],
  ['send', 'legacy-send-1', 'act.send_submit_observed', { target: 'palace:W', kind: 'submit_enter' }],
  ['send', 'legacy-send-1', 'act.send_delivered', { target: 'palace:W', bytes: 2 }],
  ['send', 'legacy-send-2', 'act.send_cancelled', { target: 'palace:W', reason: 'binding_changed' }],
] as const;

describe.skipIf(!endpoint)('migration 0012 send purge (live postgres 18)', () => {
  let raw: SQL;

  beforeAll(async () => {
    raw = await connectDb(endpoint!);
    // Clean slate: connect() re-applies the forward-only migrations from zero.
    await raw`drop schema if exists replay cascade`;
    await raw`drop schema if exists bus cascade`;
    await raw`drop schema if exists telemetry cascade`;
    await raw`drop schema if exists txd cascade`;
    await raw`drop table if exists schema_migrations`;
  });

  afterAll(async () => {
    await raw?.close();
  });

  test('boot purges exactly the historical act.send_* rows and replays the survivors', async () => {
    // Stand the schema, then write a legitimate history around the legacy rows.
    const seeded = await PostgresEventStore.connect(endpoint!);
    const prov = { source: 'wrapper' as const, transport_receipt: null, emitter_version: 4 };
    await seeded.append({
      entity_type: 'seat', entity_id: 'palace:W', event_type: 'reg.pane_created',
      payload: { pane_state: 'live' }, provenance: prov, occurred_at: '2026-07-01T00:00:00.000Z',
    });
    // Seed the legacy rows raw: the append boundary refuses them, but the
    // table itself fences only UPDATE/DELETE/TRUNCATE — exactly how the
    // historical rows exist in a real store.
    for (const [entity_type, entity_id, event_type, payload] of LEGACY_SEND_ROWS) {
      await raw`
        INSERT INTO txd.events (entity_type, entity_id, event_type, payload, provenance, occurred_at, recorded_at)
        VALUES (${entity_type}, ${entity_id}, ${event_type}, ${payload as Record<string, unknown>},
                ${prov}, '2026-07-01T00:00:01.000Z', '2026-07-01T00:00:01.000Z')`;
    }
    await seeded.append({
      entity_type: 'seat', entity_id: 'palace:W', event_type: 'reg.bound',
      payload: { instance_id: 'i1', persona: 'p', tint: '#111111' }, provenance: prov,
      occurred_at: '2026-07-01T00:00:02.000Z',
    });
    // A store carrying legacy rows cannot replay: the boundary refuses loudly.
    await expect(seeded.readAll()).rejects.toThrow();
    await seeded.close();

    // Re-arm 0012 (a real historical store simply has never applied it) and
    // boot again through the daemon's own path.
    await raw`delete from schema_migrations where id = 12`;
    const store = await PostgresEventStore.connect(endpoint!);

    const survivors = (await raw`
      SELECT seq, event_type FROM txd.events ORDER BY seq`) as { seq: number | bigint | string; event_type: string }[];
    // Exactly the legacy rows are gone; the surviving rows keep their original
    // seq values (1 and 7 around the five purged rows) — never renumbered.
    expect(survivors.map((r) => r.event_type)).toEqual(['reg.pane_created', 'reg.bound']);
    expect(survivors.map((r) => Number(r.seq))).toEqual([1, 7]);

    // Replay is clean end-to-end: the full read parses and folds.
    const events = await store.readAll();
    expect(events).toHaveLength(2);
    const projections = buildProjections(events);
    expect(projections.currentBindings.map((b) => b.seat_id)).toEqual(['palace:W']);
    expect(projections.currentBindings[0]!.bound_seq).toBe(7);

    // Idempotent: re-arming and re-running the migration purges nothing more.
    await raw`delete from schema_migrations where id = 12`;
    const again = await PostgresEventStore.connect(endpoint!);
    expect(await again.count()).toBe(2);
    await again.close();
    await store.close();
  });
});
