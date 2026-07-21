import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import { findTmuxId, findTmuxIdDeep, assertNoTmuxId } from '../src/ids.ts';

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

test('assertNoTmuxId throws loud on a leak', async () => {
  expect(() => assertNoTmuxId({ pane: '%5' }, 'test')).toThrow(/canonical-id breach/);
});

test('no tmux id appears in any /agents/*, /ingress/hooks/stop, /tmux/read, or /ctl response', async () => {
  const d = new Daemon(new MemoryEventStore(), new FakeTmux());
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build: { version: '0.1.0', git_sha: 'test', bun: '1.0' }, machine: 'test' });
  try {
    const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', body: JSON.stringify(body) });
    const bodies: unknown[] = [];
    bodies.push(await (await post('/agents/launch', { seat_id: 'somnium:NE', schema_version: 3, identity: 'i1', persona: 'p', tint: '#1' })).json());
    bodies.push(await (await post('/agents/send', { target: 'somnium:NE', text: 'hello', schema_version: 3 })).json());
    bodies.push(await (await post('/ingress/hooks/stop', { instance_id: 'i1', schema_version: 3 })).json());
    bodies.push(await (await fetch(`http://127.0.0.1:${srv.port}/tmux/read/estate`)).json());
    bodies.push(await (await post('/ctl/reconcile', {})).json());
    bodies.push(await (await fetch(`http://127.0.0.1:${srv.port}/ctl/health`)).json());
    for (const b of bodies) expect(findTmuxIdDeep(b)).toBeNull();
  } finally {
    srv.stop(true);
  }
});

test('no tmux id lands in any persisted event payload', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'p', tint: '#1' });
  await d.send({ target: 'palace:W', text: 'hi', schema_version: 3 });
  await d.reconcile();
  for (const e of await store.readAll()) {
    expect(findTmuxIdDeep(e.payload)).toBeNull();
    expect(findTmuxId(e.entity_id)).toBeNull();
  }
  await store.close();
});
