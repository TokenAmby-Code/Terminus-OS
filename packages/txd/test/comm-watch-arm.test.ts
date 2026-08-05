// The pre-send comm watch: the committed obligation in lifecycled's contract
// (its `context` field names txd's send path as the live caller) made true.
// txd arms a one-shot prompt_submitted subscription carrying the comm
// message_id BEFORE the bytes go to the pane, so lifecycled's absence edge
// can redrive or fail loud when the submit fact never arrives.
//
// Arming failure is loud and leaves the pane untouched: once the gate is the
// safety boundary, bypassing it would restore the newborn dead-zone race.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon, type CommWatchArmInput } from '../src/core.ts';

async function registered(d: Daemon, store: EventStore, seat: string, identity: string): Promise<void> {
  const launched = await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', rank: 'astartes', tint: '#111111' });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
}

async function fixture(arm: ((input: CommWatchArmInput) => Promise<void>) | null) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux, undefined, undefined, null, null, arm);
  await registered(d, store, 'council:custodes', 'sender');
  await registered(d, store, 'palace:W', 'worker');
  return { store, tmux, d };
}

test('behavioral pin: an unpainted newborn receives no bytes before lcd releases its composer-interactive gate', async () => {
  const order: string[] = [];
  const armed: CommWatchArmInput[] = [];
  let release!: () => void;
  let gateStarted!: () => void;
  const started = new Promise<void>((resolve) => { gateStarted = resolve; });
  const composerInteractive = new Promise<void>((resolve) => { release = resolve; });
  const { tmux, d } = await fixture(async (input) => {
    order.push(`gate:${input.target_agent_id}`);
    armed.push(input);
    gateStarted();
    await composerInteractive;
  });
  const original = tmux.sendVerifiedToSeat.bind(tmux);
  tmux.sendVerifiedToSeat = async (seatId, id, text) => { order.push(`send:${seatId}`); return original(seatId, id, text); };

  const pending = d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'watch me', ask: false, reply: false });
  await started;

  expect(order).toEqual(['gate:worker']);
  expect(tmux.sends('palace:W')).toEqual([]);
  // Waiting on lifecycle truth must not monopolize txd's single-writer lock.
  await expect(d.clipboardPush({ schema_version: SCHEMA_VERSION, buffer_name: 'tx-clipboard' }))
    .resolves.toMatchObject({ buffer_name: 'tx-clipboard' });
  release();
  const accepted = await pending;
  expect(order).toEqual(['gate:worker', 'send:palace:W']);
  expect(armed).toEqual([{ message_id: accepted.message_id, target_agent_id: 'worker', source_agent_id: 'sender', stream_class: 'interactive' }]);
});

test('a dead readiness plane fails loud before bytes and attests the unarmed gap', async () => {
  const { store, tmux, d } = await fixture(async () => { throw new Error('lifecycled unreachable'); });

  await expect(d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'still goes', ask: false, reply: false }))
    .rejects.toThrow('lifecycled unreachable');

  expect(tmux.sends('palace:W')).toEqual([]);
  const unarmed = (await store.readAll()).filter((e) => e.event_type === 'act.comm_watch_unarmed');
  expect(unarmed.length).toBe(1);
  expect(unarmed[0]!.payload.target_agent_id).toBe('worker');
});

test('behavioral pin: a declared headless stream asserts delivery without prompt_submitted', async () => {
  const { store, tmux } = await fixture(null);
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const d = new Daemon(store, tmux, undefined, undefined, {
    machine: 'test',
    configuration: { generation: 'g', digest: 'd' },
    agentWrapper: '/wrapper',
    perpetual: {},
    commStreams: { 'palace:W': 'headless' },
    publish: async (type, payload) => { published.push({ type, payload }); },
  }, null, async (input) => {
    expect(input.stream_class).toBe('headless');
  });

  const accepted = await d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'headless control', ask: false, reply: false });
  const delivery = await d.commDelivery(accepted.message_id);

  expect(delivery.complete).toBe(true);
  expect(delivery.deliveries[0]?.delivered).toBe(true);
  expect(delivery.deliveries[0]?.asserted_at).not.toBeNull();
  expect(published).toEqual([{ type: 'agent.headless_consumed', payload: {
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker',
    message_id: accepted.message_id,
    seat_id: 'palace:W',
  } }]);
});

test('machine-feed injection shares the composer gate and carries no comm envelope', async () => {
  const { store, tmux } = await fixture(null);
  const order: string[] = [];
  const d = new Daemon(store, tmux, undefined, undefined, null, null, null, async (input) => {
    order.push(`gate:${input.target_agent_id}`);
  });
  const original = tmux.sendVerifiedToSeat.bind(tmux);
  tmux.sendVerifiedToSeat = async (seat, id, text) => {
    order.push(`inject:${seat}`);
    expect(text).toBe('machine fact');
    expect(text).not.toContain('tx comm');
    return original(seat, id, text);
  };

  const response = await d.inject({ schema_version: SCHEMA_VERSION, target_agent_id: 'worker', text: 'machine fact' });

  expect(response).toEqual({ ok: true, target_agent_id: 'worker', deferred: true });
  expect(order).toEqual(['gate:worker', 'inject:palace:W']);
});
