import { expect, test } from 'bun:test';
import { BUS_SCHEMA_VERSION, HOOK_TYPES, type BusDelivery } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { buildRoutes, makeServer } from '../src/server.ts';

function daemon() {
  return new Daemon(new MemoryEventStore(), new FakeTmux());
}
const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

// The RATIFIED public surface ([[txd-extraction-spec]] §6, hooks plane
// superseded by the central-bus ruling) — pinned exactly. Behavioral pin: the
// surface is the contract; a route appearing or vanishing here must be a
// deliberate spec change, never drift.

const RATIFIED = [
  'GET /ctl/health',
  'POST /ctl/reconcile',
  'POST /ctl/estate/rotate',
  'POST /agents/launch',
  'POST /agents/send',
  'POST /agents/close',
  'POST /agents/subscribe',
  'POST /agents/comm',
  'POST /agents/comm/wait',
  'POST /ingress/bus',
  'GET /tmux/read/estate',
] as const;

function delivery(event_type: string, payload: Record<string, unknown>, seq = 1): BusDelivery {
  return {
    schema_version: BUS_SCHEMA_VERSION,
    subscription: 'txd',
    event: {
      seq,
      event_type,
      source: 'claude',
      payload,
      provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
      occurred_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.100Z',
    },
  };
}

test('the route table is exactly the ratified planes — nothing more', () => {
  const labels = buildRoutes(daemon(), build, 'test').map((r) => r.label);
  for (const l of RATIFIED) expect(labels).toContain(l);
  expect(labels).toHaveLength(RATIFIED.length);
});

test('the bus door serves hook.stop deliveries with the ruled stop behavior', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/bus`, {
      method: 'POST',
      body: JSON.stringify(delivery('hook.stop', { instance_id: 'i1', schema_version: 6 })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      consumed: true,
      receipt: { ok: true, recorded: true, activity: 'stopped' },
    });
  } finally {
    srv.stop(true);
  }
});

test('GET /tmux/read/estate serves the estate view including who is bound', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: 6, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/tmux/read/estate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schema_version: number; rows: Array<Record<string, unknown>> };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows[0]).toMatchObject({
      seat_id: 'somnium:NE',
      binding: 'bound',
      persona: 'salamander',
      tint: '#302800',
    });
  } finally {
    srv.stop(true);
  }
});

test('comm identity ambiguity is a loud typed refusal with zero communication effects', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'source', persona: 'source-persona', tint: '#1' });
  await d.launch({ seat_id: 'palace:N', schema_version: 6, identity: 'a', persona: 'astartes', tint: '#2' });
  await d.launch({ seat_id: 'palace:S', schema_version: 6, identity: 'b', persona: 'astartes', tint: '#3' });
  const before = await store.count();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/agents/comm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 6, source_instance_id: 'source', target: 'astartes', message: 'must not land', ask: false, reply: false }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: 'comm_refused', detail: 'identity_ambiguous: astartes' });
    expect(await store.count()).toBe(before);
  } finally { srv.stop(true); }
});

// ── Adversarial: legacy stays dead ──────────────────────────────────────────
// The pre-extraction daemon surface (flat routes + the public per-entity
// event-history endpoint) must NOT survive — and neither must the direct
// /ingress/hooks/* surface (central-bus ruling: hook fan-in terminates at
// busd; txd's hook intake is the bus subscription ONLY). 404, not redirect,
// not shim, no 410 tail.

const LEGACY = [
  ['GET', '/health'],
  ['POST', '/launch'],
  ['POST', '/send'],
  ['POST', '/close'],
  ['POST', '/stop'],
  ['POST', '/subscribe'],
  ['POST', '/reconcile'],
  ['GET', '/entities'],
  ['GET', '/entities/somnium:NE/events'],
] as const;

test('adversarial: every legacy route is dead (404) — no shim, no alias', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    for (const [method, path] of LEGACY) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${encodeURI(path)}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ schema_version: 6 }) } : {}),
      });
      expect(res.status).toBe(404);
    }
  } finally {
    srv.stop(true);
  }
});

test('adversarial: the entire direct /ingress/hooks/* surface is dead — every vendor type 404s, zero footprint', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  await d.launch({ seat_id: 'palace:W', schema_version: 6, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  const before = await store.count();
  try {
    for (const hook of HOOK_TYPES) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/${hook}`, {
        method: 'POST',
        // The old consumed doors' exact valid bodies must ALSO 404 — no shim.
        body: JSON.stringify({ instance_id: 'i1', schema_version: 6 }),
      });
      expect(res.status).toBe(404);
    }
    expect(await store.count()).toBe(before); // no event recorded through a dead door
  } finally {
    srv.stop(true);
  }
});

test('adversarial: agent biography is not served — no route exposes per-entity event history', async () => {
  const routes = buildRoutes(daemon(), build, 'test');
  // No parameterized matcher resolves an event-history-shaped path, and no
  // label mentions the dead "entities" vocabulary.
  for (const r of routes) {
    expect(r.label).not.toContain('entities');
    expect(r.match('/entities/somnium:NE/events')).toBeNull();
    expect(r.match('/tmux/read/somnium:NE/events')).toBeNull();
  }
});
