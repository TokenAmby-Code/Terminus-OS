import { expect, test } from 'bun:test';
import {
  BUS_SCHEMA_VERSION,
  CLIPBOARD_BUFFER_NAME,
  HOOK_TYPES,
  SCHEMA_VERSION,
  type BusDelivery,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { EnvelopeInventoryError } from '../src/envelopes.ts';
import { buildRoutes, makeServer } from '../src/server.ts';

function daemon() {
  return new Daemon(new MemoryEventStore(), new FakeTmux());
}
const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

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

test('the bus door serves hook.stop deliveries with the ruled stop behavior', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/bus`, {
      method: 'POST',
      body: JSON.stringify(delivery('hook.stop', { agent_id: 'i1', schema_version: 11 })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      consumed: true,
      receipt: { ok: true, recorded: true, turn: 'awaiting_input' },
    });
  } finally {
    srv.stop(true);
  }
});

test('GET /tmux/read/estate serves the estate view including who is bound', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: 11, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/tmux/read/estate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema_version: number;
      rows: Array<Record<string, unknown>>;
      tints: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows[0]).toMatchObject({
      seat_id: 'somnium:NE',
      binding: 'bound',
      persona: 'salamander',
      tint: '#302800',
    });
    expect(body.tints).toContainEqual({
      seat_id: 'somnium:NE',
      binding: 'bound',
      expected: '#302800',
      observed: '#302800',
      state: 'ready',
    });
  } finally {
    srv.stop(true);
  }
});

test('GET /tmux/read/zombies translates envelope inventory failures', async () => {
  const d = new Daemon(
    new MemoryEventStore(),
    new FakeTmux(),
    undefined,
    undefined,
    null,
    async () => { throw new EnvelopeInventoryError('k12-work', 'ssh failed'); },
  );
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/tmux/read/zombies`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'envelope_inventory_failed' });
  } finally {
    srv.stop(true);
  }
});

test('comm ask sends response headers before the callback wait completes', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { release = resolve; });
  const d = daemon();
  (d as unknown as { waitComm: () => Promise<unknown> }).waitComm = () => pending;
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const response = fetch(`http://127.0.0.1:${srv.port}/agents/comm/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        ask_id: 'ask-1',
        subscriber_agent_id: 'agent-1',
      }),
    });
    expect(await Promise.race([
      response.then(() => 'headers'),
      Bun.sleep(50).then(() => 'blocked'),
    ])).toBe('headers');

    release({ ask_id: 'ask-1', complete: true, callbacks: [], outstanding: [] });
    expect(await (await response).json()).toEqual({
      ask_id: 'ask-1', complete: true, callbacks: [], outstanding: [],
    });
  } finally {
    release({ ask_id: 'ask-1', complete: true, callbacks: [], outstanding: [] });
    srv.stop(true);
  }
});

test('clipboard pull/push preserves opaque UTF-8 without persistence or execution', async () => {
  const content = 'literal %12 @8 $3\n雪 😀\ttrailing  ';
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon: new Daemon(store, tmux),
    build,
    machine: 'k12-test',
  });
  try {
    const pulled = await fetch(`http://127.0.0.1:${srv.port}/ctl/clipboard/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, content }),
    });
    expect(pulled.status).toBe(200);
    expect(await pulled.json()).toEqual({
      ok: true,
      target: 'k12-test',
      buffer_name: CLIPBOARD_BUFFER_NAME,
      bytes: new TextEncoder().encode(content).byteLength,
    });
    const pushed = await fetch(`http://127.0.0.1:${srv.port}/ctl/clipboard/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, buffer_name: CLIPBOARD_BUFFER_NAME }),
    });
    expect(pushed.status).toBe(200);
    const body = await pushed.json() as { content_base64: string; bytes: number };
    expect(Buffer.from(body.content_base64, 'base64').toString()).toBe(content);
    expect(body.bytes).toBe(new TextEncoder().encode(content).byteLength);
    expect(await store.readAll()).toEqual([]);
  } finally {
    srv.stop(true);
  }
});

test('selection commit is routed through txd and redacts the sensitive body', async () => {
  const secret = 'selection-secret\n雪 😀';
  const tmux = new FakeTmux();
  tmux.attachClient('/dev/pts/7');
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon: new Daemon(new MemoryEventStore(), tmux),
    build,
    machine: 'k12-test',
  });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/clipboard/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        client_tty: '/dev/pts/7',
        content: secret,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      target: 'k12-test',
      buffer_name: CLIPBOARD_BUFFER_NAME,
      bytes: new TextEncoder().encode(secret).byteLength,
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(new TextDecoder().decode(await tmux.readClipboard())).toBe(secret);
    expect(tmux.selectionDeliveries()).toEqual(['/dev/pts/7']);
  } finally {
    srv.stop(true);
  }
});

test('selection commit rejects an unrelated client before changing the buffer', async () => {
  const secret = 'must-not-reach-the-buffer';
  const tmux = new FakeTmux();
  tmux.attachClient('/dev/pts/7');
  await tmux.loadClipboard('existing');
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon: new Daemon(new MemoryEventStore(), tmux),
    build,
    machine: 'k12-test',
  });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/clipboard/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        client_tty: '/dev/pts/8',
        content: secret,
      }),
    });
    expect(response.status).toBe(409);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(secret);
    expect(new TextDecoder().decode(await tmux.readClipboard())).toBe('existing');
    expect(tmux.selectionDeliveries()).toEqual([]);
  } finally {
    srv.stop(true);
  }
});

test('clipboard RPC operations are serialized through the daemon writer lock', async () => {
  let releasePull!: () => void;
  let enteredPull!: () => void;
  const pullBlocked = new Promise<void>((resolve) => { releasePull = resolve; });
  const pullEntered = new Promise<void>((resolve) => { enteredPull = resolve; });
  const order: string[] = [];
  class SerializedTmux extends FakeTmux {
    override async loadClipboard(text: string): Promise<number> {
      order.push('pull-start');
      enteredPull();
      await pullBlocked;
      order.push('pull-end');
      return new TextEncoder().encode(text).byteLength;
    }

    override async readClipboard(): Promise<Uint8Array> {
      order.push('push');
      return new TextEncoder().encode('remote');
    }
  }
  const d = new Daemon(new MemoryEventStore(), new SerializedTmux());
  const pull = d.clipboardPull({ schema_version: SCHEMA_VERSION, content: 'local' });
  await pullEntered;
  const push = d.clipboardPush({ schema_version: SCHEMA_VERSION, buffer_name: CLIPBOARD_BUFFER_NAME });
  await Promise.resolve();
  expect(order).toEqual(['pull-start']);
  releasePull();
  await Promise.all([pull, push]);
  expect(order).toEqual(['pull-start', 'pull-end', 'push']);
});

test('clipboard validation errors redact sensitive payloads', async () => {
  const secret = 'never-log-this-secret';
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: daemon(), build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/clipboard/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, content: `${secret}${'\ud800'}` }),
    });
    expect(response.status).toBe(422);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('invalid_clipboard_pull_request');
  } finally {
    srv.stop(true);
  }
});

test('clipboard ingress rejects a declared oversized body before reading it', async () => {
  const route = buildRoutes(daemon(), build, 'test').find((candidate) => candidate.label === 'POST /ctl/clipboard/pull')!;
  const request = new Request('http://localhost/ctl/clipboard/pull', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String((6 * 1024 * 1024) + 4097),
    },
    body: '{}',
  });
  const response = await route.handler(request, {});
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    ok: false,
    error: 'invalid_clipboard_pull_request',
    field: '$',
  });
});

test('POST /ctl/estate/rotate resets a page in-process instead of killing the estate server', async () => {
  const tmux = new FakeTmux();
  const d = new Daemon(new MemoryEventStore(), tmux);
  await d.constructEstate();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/estate/rotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 11, force: true, scope: 'page', page: 'somnium' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, scope: 'page', seats: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'] });
    expect(tmux.killed).toBe(false);
  } finally { srv.stop(true); }
});

test('POST /ingress/tmux repairs the lost canonical seat after a pane exits', async () => {
  const tmux = new FakeTmux();
  const d = new Daemon(new MemoryEventStore(), tmux);
  await d.constructEstate();
  tmux.deleteOutOfBand('palace:E');
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ingress/tmux`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 11, event: 'pane-exited', page: 'palace' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reconstructed: true, page: 'palace', reset_seats: ['palace:E'] });
    expect(tmux.rebuiltPages()).toEqual([]);
  } finally { srv.stop(true); }
});

test('POST /ingress/tmux accepts the page-less kill-time event and sweeps the estate', async () => {
  const tmux = new FakeTmux();
  const d = new Daemon(new MemoryEventStore(), tmux);
  await d.constructEstate();
  tmux.deleteOutOfBand('somnium:SE');
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ingress/tmux`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 11, event: 'pane-killed' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, page: null, reconstructed: true, reset_seats: ['somnium:SE'] });
    expect(tmux.rebuiltPages()).toEqual([]);
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
  ['POST', '/agents/send'],
  ['POST', '/close'],
  ['POST', '/stop'],
  ['POST', '/subscribe'],
  ['POST', '/reconcile'],
  ['GET', '/entities'],
  ['GET', '/entities/somnium:NE/events'],
] as const;

test('adversarial: every legacy route is dead (404) — no shim, no alias', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    for (const [method, path] of LEGACY) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${encodeURI(path)}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ schema_version: 11 }) } : {}),
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
  await d.launch({ seat_id: 'palace:W', schema_version: 11, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  const before = await store.count();
  try {
    for (const hook of HOOK_TYPES) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/${hook}`, {
        method: 'POST',
        // The old consumed doors' exact valid bodies must ALSO 404 — no shim.
        body: JSON.stringify({ agent_id: 'i1', schema_version: 11 }),
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
