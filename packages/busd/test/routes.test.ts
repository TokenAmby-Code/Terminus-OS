import { expect, test } from 'bun:test';
import { HOOK_TYPES } from '@terminus-os/contracts';
import { MemoryBusStore } from '../src/store.ts';
import { buildRoutes, makeServer } from '../src/server.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

function deps(store = new MemoryBusStore()) {
  return { store, onAppend: () => {}, build, machine: 'test' };
}

// The busd surface — pinned exactly. Behavioral pin: the surface is the
// contract; a route appearing or vanishing here must be a deliberate change.

test('the route table is exactly /ctl/health + /ingress/events + one door per pinned vendor hook type', () => {
  const labels = buildRoutes(deps()).map((r) => r.label);
  expect(labels).toContain('GET /ctl/health');
  expect(labels).toContain('POST /ingress/events');
  for (const hook of HOOK_TYPES) expect(labels).toContain(`POST /ingress/hooks/${hook}`);
  expect(labels).toHaveLength(2 + HOOK_TYPES.length);
});

test('ALL 30 hook doors consume and journal — the 410 tail does not exist on the bus', async () => {
  const store = new MemoryBusStore(() => '2026-07-22T00:00:00.000Z');
  const srv = makeServer({ bind: '127.0.0.1', port: 0, ...deps(store) });
  try {
    for (const hook of HOOK_TYPES) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/${hook}`, {
        method: 'POST',
        body: JSON.stringify({ harness: 'claude', session_id: 's1' }),
      });
      // Every single vendor hook type is consumed: 2xx, never 410, never 404.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; seq: number; event_type: string };
      expect(body.ok).toBe(true);
      expect(body.event_type).toBe(`hook.${hook}`);
    }
    expect(await store.count()).toBe(HOOK_TYPES.length);
  } finally {
    srv.stop(true);
  }
});

test('adversarial: no handler in the table can produce the dead hook_not_consumed/410 vocabulary', async () => {
  const store = new MemoryBusStore();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, ...deps(store) });
  try {
    for (const hook of HOOK_TYPES) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/${hook}`, {
        method: 'POST',
        body: JSON.stringify({ anything: true }),
      });
      expect(res.status).not.toBe(410);
      expect(JSON.stringify(await res.json())).not.toContain('hook_not_consumed');
    }
  } finally {
    srv.stop(true);
  }
});

test('unknown paths 404 loud', async () => {
  const srv = makeServer({ bind: '127.0.0.1', port: 0, ...deps() });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/invented_hook`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  } finally {
    srv.stop(true);
  }
});

test('GET /ctl/health serves ok + lag rows; a dead store answers 503, never a cached ok', async () => {
  const store = new MemoryBusStore();
  store.setSubscription({ name: 'txd', delivery_url: 'http://127.0.0.1:7781/ingress/bus', event_pattern: 'hook.%', active: true });
  store.seedCursor('txd', 0);
  await store.append({
    event_type: 'hook.stop',
    source: 'claude',
    payload: {},
    provenance: { ingress: 'hooks', transport_receipt: 'edge_proxy', machine: 'test' },
    occurred_at: '2026-07-22T00:00:00.000Z',
  });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, ...deps(store) });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ctl/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; events: number; subscriptions: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('busd');
    expect(body.events).toBe(1);
    expect(body.subscriptions).toEqual([
      { name: 'txd', active: true, event_pattern: 'hook.%', acked_seq: 0, lag: 1 },
    ]);
  } finally {
    srv.stop(true);
  }

  const dead = new MemoryBusStore();
  dead.count = async () => {
    throw new Error('store dead');
  };
  const srv2 = makeServer({ bind: '127.0.0.1', port: 0, ...deps(dead) });
  try {
    const res = await fetch(`http://127.0.0.1:${srv2.port}/ctl/health`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  } finally {
    srv2.stop(true);
  }
});
