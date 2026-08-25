import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import { findTmuxId, findTmuxIdInIdentifiers, assertNoTmuxIdInIdentifiers } from '../src/ids.ts';
import { findTmuxIdDeep } from './tmux-id-probe.ts';
import type { TmuxControlPlane } from '../src/tmux.ts';

// Spec §7 rung 2: canonical ids are the ONLY id surface. No raw tmux id (`%N`,
// `@N`, `$N`) may appear in an API response, a log line, or an event payload.

test('findTmuxId catches pane/window/session ids and spares canonical ids', async () => {
  expect(findTmuxId('%5')).toBe('%5');
  expect(findTmuxId('pane is %123 now')).toBe('%123');
  expect(findTmuxId('@7')).toBe('@7');
  expect(findTmuxId('$2')).toBe('$2');
  // Canonical ids and ordinary text never false-positive.
  expect(findTmuxId('somnium:NE')).toBeNull();
  expect(findTmuxId('palace:W')).toBeNull();
  expect(findTmuxId('reg.bound')).toBeNull();
  expect(findTmuxId('#302800')).toBeNull();
});

test('findTmuxIdDeep walks nested structures and object keys', async () => {
  expect(findTmuxIdDeep({ a: { b: ['ok', 'still %9'] } })).toBe('$.a.b[1]');
  expect(findTmuxIdDeep({ '%4': 'x' })).toContain('key');
  expect(findTmuxIdDeep({ seat_id: 'somnium:NE', pane: 'live' })).toBeNull();
});

test('the membrane throws loud on an IDENTIFIER leak and ignores prose', async () => {
  expect(() => assertNoTmuxIdInIdentifiers({ pane: '%5' }, 'test')).toThrow(/canonical-id breach/);
  expect(() => assertNoTmuxIdInIdentifiers({ seat_id: '%5' }, 'test')).toThrow(/canonical-id breach/);
  expect(() => assertNoTmuxIdInIdentifiers({ targets: ['palace:W', '%5'] }, 'test')).toThrow(/canonical-id breach/);
  // Nested identifiers cannot hide behind a data key.
  expect(() => assertNoTmuxIdInIdentifiers({ payload: { agent_id: '@7' } }, 'test')).toThrow(/canonical-id breach/);
  // Prose is data, at any depth, whatever it happens to contain.
  expect(() => assertNoTmuxIdInIdentifiers({ message: 'from pane %28' }, 'test')).not.toThrow();
  expect(() => assertNoTmuxIdInIdentifiers({ payload: { content: 'pin zod@4.4' } }, 'test')).not.toThrow();
  expect(findTmuxIdInIdentifiers({ payload: { seat_id: 'palace:W', message: '$20' } })).toBeNull();
});

test('mutation ingress refuses a raw tmux id IN AN IDENTIFIER FIELD, before tmux or persistence', async () => {
  // The membrane is the schema: every field declaring itself an identifier
  // refuses a raw tmux id on its own path. Nothing scans request content.
  const attacks: Array<{ path: string; body: Record<string, unknown>; error: string }> = [
    { path: '/agents/launch', error: 'invalid_launch_request', body: { seat_id: '%91', schema_version: 13, identity: 'i1', persona: 'p', tint: '#1' } },
    { path: '/agents/launch', error: 'invalid_launch_request', body: { seat_id: 'palace:W', schema_version: 13, identity: '@22', persona: 'p', tint: '#1' } },
    { path: '/agents/close', error: 'invalid_close_request', body: { source_agent_id: 'ov-1', targets: ['$7'], schema_version: 13 } },
    { path: '/agents/close', error: 'invalid_close_request', body: { source_agent_id: '%3', targets: ['palace:W'], schema_version: 13 } },
  ];
  const store = new MemoryEventStore();
  let tmuxCalls = 0;
  const base = new FakeTmux();
  const tmux = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { tmuxCalls += 1; return value.apply(target, args); };
    },
  }) as TmuxControlPlane;
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: new Daemon(store, tmux), build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    for (const attack of attacks) {
      const res = await fetch(`http://127.0.0.1:${srv.port}${attack.path}`, {
        method: 'POST', body: JSON.stringify(attack.body),
      });
      expect(res.status).toBe(422);
      const response = await res.json() as Record<string, unknown>;
      expect(response).toEqual({ ok: false, error: attack.error, field: expect.any(String) });
      // The refusal must not echo the offending id back through the membrane.
      expect(findTmuxIdDeep(response)).toBeNull();
    }
    expect(tmuxCalls).toBe(0);
    expect(await store.count()).toBe(0);
  } finally {
    srv.stop(true);
  }
});

// Adversarial: content scanning stays dead. These are the shapes that were
// refused before — a package pin, a shell positional, a dollar amount, and a
// pane id quoted in prose. Each is legitimate caller content and must pass.
test('request CONTENT carrying tmux sigils is never refused', async () => {
  const store = new MemoryEventStore();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: new Daemon(store, new FakeTmux()), build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    for (const message of ['pin zod@4.4', 'the positional $1', 'it cost $20', 'attesting from pane %28']) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/agents/comm`, {
        method: 'POST',
        body: JSON.stringify({ schema_version: 13, source_agent_id: 'ov-1', target: 'palace:W', message }),
      });
      // Whatever the daemon decides about routing, it must never be a 422
      // blaming the message body for containing an identifier-shaped token.
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toMatchObject({ error: 'invalid_comm_request', field: '$.message' });
    }
  } finally {
    srv.stop(true);
  }
});


test('handler errors are sanitized before structured logging', async () => {
  class LeakingAdapter extends FakeTmux {
    override async createSeat(): Promise<void> {
      throw new Error('tmux pane %42 failed at @8 in $3');
    }
  }
  const tmux = new LeakingAdapter();
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: new Daemon(new MemoryEventStore(), tmux), build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    // Force a below-membrane adapter error containing a raw id without putting
    // that id in the request (request ingress must remain independently clean).
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/launch`, {
      method: 'POST', body: JSON.stringify({ seat_id: 'palace:W', schema_version: 13, identity: 'i1', persona: 'p', tint: '#1' }),
    });
    expect(res.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(findTmuxId(lines[0]!)).toBeNull();
  } finally {
    console.error = original;
    srv.stop(true);
  }
});

test('no tmux id appears in any /agents/*, /tmux/read, or /ctl response', async () => {
  const d = new Daemon(new MemoryEventStore(), new FakeTmux());
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', body: JSON.stringify(body) });
    const bodies: unknown[] = [];
    bodies.push(await (await post('/agents/launch', { seat_id: 'somnium:NE', schema_version: 13, identity: 'i1', persona: 'p', tint: '#1' })).json());
    bodies.push(await (await post('/agents/send', { target: 'somnium:NE', text: 'hello', schema_version: 13 })).json());
    bodies.push(await (await fetch(`http://127.0.0.1:${srv.port}/tmux/read/estate`)).json());
    bodies.push(await (await post('/ctl/reconcile', {})).json());
    bodies.push(await (await fetch(`http://127.0.0.1:${srv.port}/ctl/health`)).json());
    for (const b of bodies) expect(findTmuxIdDeep(b)).toBeNull();
  } finally {
    srv.stop(true);
  }
});

// Site 5 of the membrane enumeration: `json()` is the SINGLE shared responder
// and asserts over the WHOLE response body. A comm-wait response carries
// `callbacks[].content` — an agent's reply text or its stop-hook last message.
//
// This path is untestable end-to-end today, because content quoting a sigil
// cannot be persisted to become a callback in the first place. It is driven
// here directly at its own boundary instead, so the classification rests on an
// observation rather than on reading the code path.
test('a comm-wait response carrying an agent reply that quotes a tmux id breaches on the way out', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  // The agent answered an ask by quoting the pane it was reporting from.
  (daemon as unknown as { waitComm: () => Promise<unknown> }).waitComm = async () => ({
    ask_id: 'ask-1',
    complete: true,
    callbacks: [{
      target: { agent_id: 'a-1', seat_id: 'palace:W', persona: 'p' },
      content: 'attesting from pane %28',
      assertion_event_id: 1,
      source: 'reply' as const,
    }],
    outstanding: [],
  });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon, build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/comm/wait`, {
      method: 'POST',
      body: JSON.stringify({ schema_version: 13, ask_id: 'ask-1', subscriber_agent_id: 'ov-1' }),
    });
    // TODAY: the response membrane scans the agent's prose and throws, so the
    // caller gets a handler failure instead of its answer.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ask_id: 'ask-1',
      callbacks: [{ content: 'attesting from pane %28' }],
    });
  } finally {
    srv.stop(true);
  }
});
