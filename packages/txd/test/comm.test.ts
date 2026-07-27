import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function setup() {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await daemon.launch({ seat_id: 'palace:W', schema_version: 8, identity: 'source', persona: 'custodes', tint: '#1' });
  await daemon.launch({ seat_id: 'somnium:N', schema_version: 8, identity: 'target-a', persona: 'pax', tint: '#2' });
  await daemon.launch({ seat_id: 'somnium:S', schema_version: 8, identity: 'target-b', persona: 'astartes', tint: '#3' });
  return { store, daemon };
}

test('identity trinity resolves instance, singleton persona, and canonical pane with one frozen target', async () => {
  for (const identity of ['target-a', 'pax', 'somnium:N']) {
    const { daemon } = await setup();
    const result = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: identity, message: 'hello', ask: false, reply: false });
    expect(result.targets).toEqual([{ instance_id: 'target-a', seat_id: 'somnium:N', persona: 'pax' }]);
    expect(result.bytes_sent).toBe(true);
  }
});

test('absence and ambiguity refuse before communication effects', async () => {
  const { store, daemon } = await setup();
  const before = await store.count();
  await expect(daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'absent', message: 'x', ask: false, reply: false })).rejects.toThrow('identity_absent');
  expect(await store.count()).toBe(before);
  await daemon.launch({ seat_id: 'palace:E', schema_version: 8, identity: 'other-pax', persona: 'pax', tint: '#4' });
  const beforeAmbiguous = await store.count();
  await expect(daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'pax', message: 'x', ask: false, reply: false })).rejects.toThrow('identity_ambiguous');
  expect(await store.count()).toBe(beforeAmbiguous);
});

test('pending scoped reset fences comm before acceptance or physical transport', async () => {
  const { store, daemon } = await setup();
  const binding = (await store.readAll()).find((event) =>
    event.entity_id === 'somnium:N' && event.event_type === 'reg.bound',
  )!;
  await store.append({
    entity_type: 'estate',
    entity_id: 'comm-reset-fence',
    event_type: 'estate.scoped_reset_requested',
    payload: {
      scope: 'pane',
      seats: ['somnium:N'],
      force: true,
      bound_seats: ['somnium:N'],
      bound_generations: [{
        seat_id: 'somnium:N',
        bound_seq: binding.seq,
        pane_generation: binding.payload.pane_generation,
      }],
      foreground_workloads: [],
      trigger: 'operator',
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: 8 },
    occurred_at: new Date().toISOString(),
  });
  const before = await store.count();

  await expect(daemon.comm({
    schema_version: 8,
    source_instance_id: 'source',
    target: 'target-a',
    message: 'must not cross reset fence',
    ask: false,
    reply: false,
  })).rejects.toThrow('scoped_reset_pending: somnium:N');
  expect(await store.count()).toBe(before);
});

test('page resolution is an immutable exact inventory and payload stays opaque', async () => {
  const { store, daemon } = await setup();
  const message = '---\na: 1\n---\n{"x":"λ\\n\\\""}';
  const result = await daemon.comm({ schema_version: 8, source_instance_id: 'source', page: 'somnium', message, ask: false, reply: false });
  expect(result.targets.map((t) => t.instance_id)).toEqual(['target-a', 'target-b']);
  const accepted = (await store.readAll()).find((e) => e.entity_id === result.message_id && e.event_type === 'reg.comm_accepted')!;
  expect(accepted.payload.message).toBe(message);
  expect((await store.readAll()).filter((e) => e.entity_id === result.message_id && e.event_type === 'act.comm_bytes_sent')).toHaveLength(2);
});

test('delivery assertion is asynchronous, replay-safe, and echoes separately', async () => {
  const { store, daemon } = await setup();
  const sent = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'x', ask: false, reply: false });
  expect((await store.readAll()).some((e) => e.event_type === 'act.comm_delivery_asserted')).toBe(false);
  expect(await daemon.promptSubmitted({ schema_version: 8, instance_id: 'target-a', message_id: sent.message_id })).toEqual({ ok: true, asserted: true });
  expect(await daemon.promptSubmitted({ schema_version: 8, instance_id: 'target-a', message_id: sent.message_id })).toEqual({ ok: true, asserted: false });
  expect((await store.readAll()).filter((e) => e.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
});

test('one-way communication never subscribes its sender or contaminates a later ask callback', async () => {
  const { store, daemon } = await setup();
  await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'one-way', ask: false, reply: false });
  const ask = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'real ask', ask: true, reply: false });
  await daemon.commStop('target-a', 'ordinary turn content', 'stop-one-way', null);
  const callbacks = (await store.readAll()).filter((e) => e.event_type === 'act.comm_callback_asserted');
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0]).toMatchObject({ payload: { ask_id: ask.ask_id, content: 'ordinary turn content' } });
});

test('explicit reply wins over stop fallback and produces exactly one callback', async () => {
  const { store, daemon } = await setup();
  const ask = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'question', ask: true, reply: false });
  await daemon.comm({ schema_version: 8, source_instance_id: 'target-a', message: 'answer', ask: false, reply: true });
  await daemon.commStop('target-a', 'fallback', 'stop-1', null);
  const result = await daemon.waitComm({ schema_version: 8, ask_id: ask.ask_id!, subscriber_instance_id: 'source', timeout_ms: 420_000 });
  expect(result.complete).toBe(true);
  expect(result.callbacks).toHaveLength(1);
  expect(result.callbacks[0]).toMatchObject({ content: 'answer', source: 'reply' });
  expect((await store.readAll()).filter((e) => e.event_type === 'act.comm_callback_asserted')).toHaveLength(1);
});

test('stop fallback aggregates one replay-safe callback per page target', async () => {
  const { store, daemon } = await setup();
  const ask = await daemon.comm({ schema_version: 8, source_instance_id: 'source', page: 'somnium', message: 'report', ask: true, reply: false });
  await daemon.commStop('target-a', 'A', 'same-stop', null);
  await daemon.commStop('target-a', 'duplicate', 'same-stop', null);
  await daemon.commStop('target-b', 'B', 'stop-b', null);
  const result = await daemon.waitComm({ schema_version: 8, ask_id: ask.ask_id!, subscriber_instance_id: 'source', timeout_ms: 420_000 });
  expect(result.complete).toBe(true);
  expect(result.callbacks.map((c) => c.content).sort()).toEqual(['A', 'B']);
  expect(result.outstanding).toEqual([]);
  expect((await store.readAll()).filter((e) => e.event_type === 'act.comm_callback_asserted')).toHaveLength(2);
});

test('overlapping subscriptions to one stop and subscriber collapse to one assertion', async () => {
  const { store, daemon } = await setup();
  const first = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'one', ask: true, reply: false });
  const second = await daemon.comm({ schema_version: 8, source_instance_id: 'source', target: 'target-a', message: 'two', ask: true, reply: false });
  await daemon.commStop('target-a', 'single stop content', 'shared-stop-event', null);
  expect((await store.readAll()).filter((e) => e.event_type === 'act.comm_callback_asserted')).toHaveLength(1);
  expect((await daemon.waitComm({ schema_version: 8, ask_id: first.ask_id!, subscriber_instance_id: 'source', timeout_ms: 420_000 })).complete).toBe(true);
  expect((await daemon.waitComm({ schema_version: 8, ask_id: second.ask_id!, subscriber_instance_id: 'source', timeout_ms: 420_000 })).complete).toBe(true);
});

test('reply targets the latest inbound sender without cancelling an older ask fallback', async () => {
  const { daemon } = await setup();
  const older = await daemon.comm({ schema_version: 8, source_instance_id: 'target-a', target: 'source', message: 'ask', ask: true, reply: false });
  await daemon.comm({ schema_version: 8, source_instance_id: 'target-b', target: 'source', message: 'newest', ask: false, reply: false });
  const reply = await daemon.comm({ schema_version: 8, source_instance_id: 'source', message: 'to B', ask: false, reply: true });
  expect(reply.targets[0]!.instance_id).toBe('target-b');
  await daemon.commStop('source', 'fallback to A', 'stop-source', null);
  expect((await daemon.waitComm({ schema_version: 8, ask_id: older.ask_id!, subscriber_instance_id: 'target-a', timeout_ms: 420_000 })).callbacks[0]!.content).toBe('fallback to A');
});
