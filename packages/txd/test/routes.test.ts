import { expect, test } from 'bun:test';
import { HOOK_TYPES } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { buildRoutes, makeServer, CONSUMED_HOOK_TYPES } from '../src/server.ts';

function daemon() {
  return new Daemon(new MemoryEventStore(), new FakeTmux());
}
const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

// The RATIFIED public surface ([[txd-extraction-spec]] §6) — pinned exactly.
// Behavioral pin: the surface is the contract; a route appearing or vanishing
// here must be a deliberate spec change, never drift.

const RATIFIED = [
  'GET /ctl/health',
  'POST /ctl/reconcile',
  'POST /agents/launch',
  'POST /agents/send',
  'POST /agents/close',
  'POST /agents/subscribe',
  'POST /ingress/hooks/stop',
  'GET /tmux/read/estate',
] as const;

test('the route table is exactly the ratified planes + one endpoint per pinned vendor hook type', async () => {
  const labels = buildRoutes(daemon(), build, 'test').map((r) => r.label);
  for (const l of RATIFIED) expect(labels).toContain(l);
  // Hook invariant: EVERY pinned vendor hook type has an endpoint.
  for (const hook of HOOK_TYPES) expect(labels).toContain(`POST /ingress/hooks/${hook}`);
  // And nothing else: ratified + one per non-consumed hook type.
  expect(labels).toHaveLength(RATIFIED.length + (HOOK_TYPES.length - CONSUMED_HOOK_TYPES.length));
});

test('the consumed stop door is registered before the 410 tail (ordering is data)', async () => {
  const labels = buildRoutes(daemon(), build, 'test').map((r) => r.label);
  const stopIdx = labels.indexOf('POST /ingress/hooks/stop');
  const firstGone = labels.findIndex((l, i) => l.startsWith('POST /ingress/hooks/') && i !== stopIdx);
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(stopIdx).toBeLessThan(firstGone);
});

test('unused vendor hook types quick-return 410 and are side-effect-free', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    for (const hook of HOOK_TYPES) {
      if (CONSUMED_HOOK_TYPES.includes(hook)) continue;
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/${hook}`, {
        method: 'POST',
        body: JSON.stringify({ anything: true }),
      });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ ok: false, error: 'hook_not_consumed', hook_type: hook });
    }
    expect(await store.count()).toBe(0); // side-effect-free by construction: zero events
  } finally {
    srv.stop(true);
  }
});

test('the stop-hook door serves at /ingress/hooks/stop with the ruled stop behavior', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'palace:W', schema_version: 2, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/stop`, {
      method: 'POST',
      body: JSON.stringify({ instance_id: 'i1', schema_version: 2 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, recorded: true, activity: 'stopped' });
  } finally {
    srv.stop(true);
  }
});

test('GET /tmux/read/estate serves the estate view including who is bound', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: 2, identity: 'i1', persona: 'salamander', tint: '#302800' });
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

// ── Adversarial: legacy stays dead ──────────────────────────────────────────
// The pre-extraction daemon surface (flat routes + the public per-entity
// event-history endpoint) must NOT survive. 404, not redirect, not shim
// ([[txd-extraction-spec]] §6: zero live callers — the re-shape is free; no
// compat layer exists).

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
  await d.launch({ seat_id: 'somnium:NE', schema_version: 2, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    for (const [method, path] of LEGACY) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${encodeURI(path)}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ schema_version: 2 }) } : {}),
      });
      expect(res.status).toBe(404);
    }
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
