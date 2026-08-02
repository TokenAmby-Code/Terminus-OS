// ADVERSARIAL — the txd-internal close-on-stop subscription is dead.
// Lifecycle correlation (who wants to know when agent X stops, and what fires
// then) is lifecycled's authority; txd keeps only the mechanical executors
// (/agents/close, /agents/mode). This suite is the one place the corpse is
// remembered: runtime code never acknowledges the removal.
import { expect, test } from 'bun:test';
import { EVENT_TYPES, SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { buildProjections } from '../src/projections.ts';
import { makeServer } from '../src/server.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

const FULL = { schema_version: SCHEMA_VERSION, identity: 'i1', persona: 'salamander', tint: '#302800' } as const;

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  return { store, tmux, d: new Daemon(store, tmux) };
}

test('the daemon exposes no subscribe surface', () => {
  const { d } = setup();
  expect((d as unknown as Record<string, unknown>).subscribe).toBeUndefined();
});

test('POST /agents/subscribe is not a route', async () => {
  const { d } = setup();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, agent_id: 'i1', action: 'close' }),
    });
    expect(res.status).toBe(404);
  } finally {
    srv.stop(true);
  }
});

test('reg.stop_subscribed is not a registered event type', () => {
  expect(EVENT_TYPES).not.toContain('reg.stop_subscribed');
});

test('a stop never closes: activity folds to stopped, the binding stands, no retirement is written', async () => {
  const { store, d } = setup();
  await d.launch({ seat_id: 'palace:W', ...FULL });
  const res = await d.stop({ agent_id: 'i1', schema_version: SCHEMA_VERSION });
  expect(res).toMatchObject({ ok: true, recorded: true });
  expect('auto_close' in (res as Record<string, unknown>)).toBe(false);
  const events = await store.readAll();
  const types = events.map((e) => e.event_type);
  expect(types).toContain('act.stop_reported');
  expect(types).not.toContain('reg.retired');
  expect(types).not.toContain('reg.seat_cleared');
  const proj = buildProjections(events);
  expect(proj.currentBindings.some((b) => b.agent_id === 'i1')).toBe(true);
  expect('openStopSubscriptions' in (proj as unknown as Record<string, unknown>)).toBe(false);
});

test('a journaled reg.stop_subscribed from a dead generation is refused by the store contract', async () => {
  const { store } = setup();
  await expect(store.append({
    entity_type: 'agent',
    entity_id: 'i1',
    event_type: 'reg.stop_subscribed',
    payload: { action: 'close' },
    provenance: { actor: 'wrapper', transport_receipt: null },
    occurred_at: new Date().toISOString(),
  } as never)).rejects.toThrow();
});
