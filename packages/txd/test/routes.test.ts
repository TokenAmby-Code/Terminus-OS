import { expect, test } from 'bun:test';
import {
  CLIPBOARD_BUFFER_NAME,
  SCHEMA_VERSION,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { resolveSshSeatTargets } from '../src/config.ts';
import { EnvelopeInventoryError } from '../src/envelopes.ts';
import { buildRoutes, deferredJson, makeServer } from '../src/server.ts';
import { commFrame, commTokenForMessageId } from '../src/comm-frame.ts';

function daemon() {
  return new Daemon(new MemoryEventStore(), new FakeTmux());
}

test('GET /tmux/read/estate serves the estate view including who is bound', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
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

test('POST /ctl/estate/compact-events carries the operator archive attestation to txd', async () => {
  const d = daemon();
  const calls: unknown[] = [];
  (d as unknown as { compactEventLog: (request: unknown) => Promise<unknown> }).compactEventLog = async (request) => {
    calls.push(request);
    return { ok: true, boundary_seq: 7, archived_events: 6, retained_events: 5 };
  };
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const body = {
      schema_version: SCHEMA_VERSION,
      source_agent_id: 'operator-agent',
      reset_journal_head: 8722,
      archive_attestation: 'snapshot=~/backups/reset-point-2026-08-23;restore-proof=journal.head=8739',
    };
    const res = await fetch(`http://127.0.0.1:${srv.port}/ctl/estate/compact-events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, boundary_seq: 7, archived_events: 6, retained_events: 5 });
    expect(calls).toEqual([body]);
  } finally {
    srv.stop(true);
  }
});

test('POST /ctl/estate/compact-events refuses a missing archive attestation', async () => {
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: daemon(), machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ctl/estate/compact-events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, source_agent_id: 'operator-agent', reset_journal_head: 8722 }),
    });
    expect(res.status).toBe(422);
  } finally {
    srv.stop(true);
  }
});

test('GET /tmux/read/diagnostics/hooks serves a bounded typed journal view', async () => {
  const limits: number[] = [];
  const srv = makeServer({
    bind: '127.0.0.1', port: 0, daemon: daemon(), machine: 'test',
    hookDiagnostics: async (limit) => {
      limits.push(limit);
      return [{ recorded_at: '2026-08-17T17:00:00.000Z', priority: 3, message: 'Unable to connect' }];
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/tmux/read/diagnostics/hooks?limit=7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      schema_version: SCHEMA_VERSION,
      source: 'systemd-journal',
      identifier: 'txd-tmux-hook',
      diagnostics: [{ recorded_at: '2026-08-17T17:00:00.000Z', priority: 3, message: 'Unable to connect' }],
    });
    expect(limits).toEqual([7]);

    expect((await fetch(`http://127.0.0.1:${srv.port}/tmux/read/diagnostics/hooks?limit=0`)).status).toBe(422);
    expect(limits).toEqual([7]);
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
    {
      machine: 'k12-personal',
      configuration: { generation: 'test', digest: 'c'.repeat(64) },
      agentWrapper: '/fleet/agent-wrapper',
      perpetual: {},
      sshSeatTargets: resolveSshSeatTargets({ pages: { somnium: 'k12-work' }, seats: {} }),
      publish: async () => {},
    },
    async () => { throw new EnvelopeInventoryError('k12-work', 'ssh failed'); },
  );
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
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
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
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

test('comm admission returns its durable message id before pane delivery finishes, then the receipt joins the emitted transport fact', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
    await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', rank: 'astartes', tint: '#111111' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-22T12:00:00.000Z',
    });
  }

  let transportStarted!: () => void;
  const started = new Promise<void>((resolve) => { transportStarted = resolve; });
  let releaseTransport!: () => void;
  const held = new Promise<void>((resolve) => { releaseTransport = resolve; });
  const send = tmux.sendVerifiedToSeat.bind(tmux);
  tmux.sendVerifiedToSeat = async (...args) => {
    transportStarted();
    await held;
    return send(...args);
  };

  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  let admissionResponse: Response | undefined;
  try {
    const admissionPending = fetch(`http://127.0.0.1:${srv.port}/agents/comm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: 'sender',
        target: 'target',
        message: 'durable sender receipt',
        ask: false,
        reply: false,
      }),
    });
    await started;
    admissionResponse = await Promise.race([
      admissionPending,
      Bun.sleep(100).then(() => undefined),
    ]);
    expect(admissionResponse).toBeInstanceOf(Response);
    const admission = await admissionResponse!.json() as { message_id: string };
    expect(admission.message_id).toMatch(/^[0-9a-f-]{36}$/);

    const receiptPending = fetch(`http://127.0.0.1:${srv.port}/agents/comm/receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: 'sender',
        message_id: admission.message_id,
      }),
    }).then((response) => response.json());

    releaseTransport();
    await d.promptSubmitted({
      schema_version: SCHEMA_VERSION,
      agent_id: 'target',
      comm_tokens: [commTokenForMessageId(admission.message_id)],
    });
    expect(await receiptPending).toMatchObject({
      ok: true,
      phase: 'delivery_confirmed',
      message_id: admission.message_id,
    });
  } finally {
    releaseTransport();
    srv.stop(true);
  }
});

test('a pane transport exception after comm admission becomes a durable refusal receipt', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
    await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', rank: 'astartes', tint: '#111111' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-22T12:00:00.000Z',
    });
  }
  let transportStarted!: () => void;
  const started = new Promise<void>((resolve) => { transportStarted = resolve; });
  let releaseTransport!: () => void;
  const held = new Promise<void>((resolve) => { releaseTransport = resolve; });
  tmux.sendVerifiedToSeat = async () => {
    transportStarted();
    await held;
    throw new Error('pane transport rejected');
  };

  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const admission = await (await fetch(`http://127.0.0.1:${srv.port}/agents/comm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: 'sender',
        target: 'target',
        message: 'refusal receipt',
        ask: false,
        reply: false,
      }),
    })).json() as { message_id: string };
    await started;
    const receipt = fetch(`http://127.0.0.1:${srv.port}/agents/comm/receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: 'sender',
        message_id: admission.message_id,
      }),
    }).then((response) => response.json());
    releaseTransport();
    expect(await receipt).toMatchObject({
      ok: false,
      phase: 'transport_refused',
      message_id: admission.message_id,
      submit_verdict: 'transport_failed',
    });
  } finally {
    releaseTransport();
    srv.stop(true);
  }
});

test('comm ask stream emits legal JSON whitespace while awaiting its callback event', async () => {
  const pending = new Promise<unknown>(() => {});
  let emitKeepalive!: () => void;
  const reader = deferredJson(pending, 30_000, (emit) => {
    emitKeepalive = emit;
    return () => {};
  }).body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(' ');
    const keepalive = reader.read();
    emitKeepalive();
    expect(new TextDecoder().decode((await keepalive).value)).toBe(' ');
  } finally {
    await reader.cancel();
  }
});

test('comm ask remains connected beyond Bun default idle timeout', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { release = resolve; });
  const d = daemon();
  (d as unknown as { waitComm: () => Promise<unknown> }).waitComm = () => pending;
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/agents/comm/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        ask_id: 'ask-long',
        subscriber_agent_id: 'agent-1',
      }),
    });
    await Bun.sleep(12_000);
    release({ ask_id: 'ask-long', complete: true, callbacks: [], outstanding: [] });
    expect(await response.json()).toEqual({
      ask_id: 'ask-long', complete: true, callbacks: [], outstanding: [],
    });
  } finally {
    release({ ask_id: 'ask-long', complete: true, callbacks: [], outstanding: [] });
    srv.stop(true);
  }
}, 16_000);

test('clipboard pull/push preserves opaque UTF-8 without persistence or execution', async () => {
  const content = 'literal %12 @8 $3\n雪 😀\ttrailing  ';
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon: new Daemon(store, tmux),
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
  const store = new MemoryEventStore();
  tmux.attachClient('/dev/pts/7');
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    daemon: new Daemon(store, tmux),
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
      outcome: 'delivered',
      origin: 'wsl',
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(new TextDecoder().decode(await tmux.readClipboard())).toBe(secret);
    expect(tmux.selectionDeliveries()).toEqual(['/dev/pts/7']);
    // Clipboard payload never enters replay truth, so replay cannot duplicate
    // the private transport effect or resurrect content after it is gone.
    expect(await store.readAll()).toEqual([]);
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
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, outcome: 'disconnected_origin' });
    const serialized = JSON.stringify(body);
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
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: daemon(), machine: 'test' });
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
  const route = buildRoutes(daemon(), 'test').find((candidate) => candidate.label === 'POST /ctl/clipboard/pull')!;
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
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/estate/rotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 13, force: true, scope: 'page', page: 'somnium' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, scope: 'page', seats: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'] });
    expect(tmux.killed).toBe(false);
  } finally { srv.stop(true); }
});

test('POST /ctl/estate/abandon routes the exact overseer abandonment request', async () => {
  const d = daemon();
  let received: unknown;
  d.abandonSeats = async (request) => {
    received = request;
    return { ok: true, abandoned: request.seats, reason: null };
  };
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ctl/estate/abandon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: 'council-custodes-agent',
        seats: ['palace_fleet:dead-seat'],
      }),
    });
    expect(response.status).toBe(200);
    expect(received).toEqual({
      schema_version: SCHEMA_VERSION,
      source_agent_id: 'council-custodes-agent',
      seats: ['palace_fleet:dead-seat'],
    });
    expect(await response.json()).toEqual({
      ok: true, abandoned: ['palace_fleet:dead-seat'], reason: null,
    });
  } finally {
    srv.stop(true);
  }
});

test('POST /ingress/tmux repairs the lost canonical seat after a pane exits', async () => {
  const tmux = new FakeTmux();
  const d = new Daemon(new MemoryEventStore(), tmux);
  await d.constructEstate();
  tmux.deleteOutOfBand('palace:E');
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ingress/tmux`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 13, event: 'pane-exited', page: 'palace' }),
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
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/ingress/tmux`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 13, event: 'pane-killed' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, page: null, reconstructed: true, reset_seats: ['somnium:SE'] });
    expect(tmux.rebuiltPages()).toEqual([]);
  } finally { srv.stop(true); }
});

// ── Adversarial: legacy stays dead ──────────────────────────────────────────
// The pre-extraction daemon surface (flat routes + the public per-entity
// event-history endpoint) must NOT survive. Raw hooks belong to lifecycled's
// direct typed lane; journal facts enter through txd's owned cursor, not HTTP.
// 404, not redirect, not shim, no 410 tail.

const LEGACY = [
  ['GET', '/health'],
  ['POST', '/launch'],
  ['POST', '/send'],
  ['POST', '/agents/send'],
  ['POST', '/close'],
  ['POST', '/stop'],
  ['POST', '/subscribe'],
  ['POST', '/reconcile'],
  ['POST', '/ingress/bus'],
  ['GET', '/entities'],
  ['GET', '/entities/somnium:NE/events'],
] as const;

test('adversarial: every legacy route is dead (404) — no shim, no alias', async () => {
  const d = daemon();
  await d.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'i1', persona: 'p', tint: '#1' });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    for (const [method, path] of LEGACY) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${encodeURI(path)}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ schema_version: 13 }) } : {}),
      });
      expect(res.status).toBe(404);
    }
  } finally {
    srv.stop(true);
  }
});

test('UserPromptSubmit enters txd directly and asserts the correlated comm delivery', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  await d.launch({ seat_id: 'council:custodes', schema_version: 13, identity: 'sender', persona: 'p', tint: '#1' });
  await d.launch({ seat_id: 'palace:W', schema_version: 13, identity: 'target', persona: 'p', tint: '#1' });
  for (const identity of ['sender', 'target']) await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-15T17:00:00.000Z',
  });
  const accepted = await d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target', message: 'receipt me', ask: false, reply: false });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/hooks/user_prompt_submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-edge-proxy': 'hook-receipt-1' },
      body: JSON.stringify({ agent_id: 'target', prompt: commFrame(accepted.message_id, { persona: 'p', seat_id: 'council:custodes' }, 'receipt me') }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, asserted: [accepted.message_id] });
    expect((await d.commDelivery(accepted.message_id)).complete).toBeTrue();
  } finally {
    srv.stop(true);
  }
});

test('adversarial: agent biography is not served — no route exposes per-entity event history', async () => {
  const routes = buildRoutes(daemon(), 'test');
  // No parameterized matcher resolves an event-history-shaped path, and no
  // label mentions the dead "entities" vocabulary.
  for (const r of routes) {
    expect(r.label).not.toContain('entities');
    expect(r.match('/entities/somnium:NE/events')).toBeNull();
    expect(r.match('/tmux/read/somnium:NE/events')).toBeNull();
  }
});
