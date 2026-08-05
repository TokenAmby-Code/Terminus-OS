// The pre-send comm watch: the committed obligation in lifecycled's contract
// (its `context` field names txd's send path as the live caller) made true.
// txd arms a one-shot prompt_submitted subscription carrying the comm
// message_id BEFORE the bytes go to the pane, so lifecycled's absence edge
// can redrive or fail loud when the submit fact never arrives.
//
// Arming failure is DEGRADED, not fatal: comms delivered for months without
// the watch plane, so a dead lifecycled must not take comm availability with
// it — but the degradation is attested (act.comm_watch_unarmed), never silent.

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

test('the watch is armed once per target, BEFORE the bytes reach the pane', async () => {
  const order: string[] = [];
  const armed: CommWatchArmInput[] = [];
  const { tmux, d } = await fixture(async (input) => { order.push(`arm:${input.target_agent_id}`); armed.push(input); });
  const original = tmux.sendToSeat.bind(tmux);
  tmux.sendToSeat = async (seatId, text) => { order.push(`send:${seatId}`); return original(seatId, text); };

  const accepted = await d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'watch me', ask: false, reply: false });

  expect(order).toEqual(['arm:worker', 'send:palace:W']);
  expect(armed).toEqual([{ message_id: accepted.message_id, target_agent_id: 'worker', source_agent_id: 'sender' }]);
});

test('a dead watch plane degrades LOUDLY: the comm still sends, the gap is attested', async () => {
  const { store, tmux, d } = await fixture(async () => { throw new Error('lifecycled unreachable'); });

  const accepted = await d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'still goes', ask: false, reply: false });

  expect(accepted.staged).toBe(true);
  expect(tmux.sends('palace:W').some((t) => t.includes('still goes'))).toBe(true);
  const unarmed = (await store.readAll()).filter((e) => e.event_type === 'act.comm_watch_unarmed');
  expect(unarmed.length).toBe(1);
  expect(unarmed[0]!.payload.message_id).toBe(accepted.message_id);
  expect(unarmed[0]!.payload.target_agent_id).toBe('worker');
});
