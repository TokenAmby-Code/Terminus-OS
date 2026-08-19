// Adversarial lane: the turn-stop join asserts delivery ONLY with the full
// evidence chain — staged transport, verified frame departure, target working
// at send, and the target's own stop. Any partial chain stays undelivered
// forever; transport observation alone can never manufacture delivery truth.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function rig() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target'], ['palace:X', 'bystander']] as const) {
    await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', tint: '#1' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-19T00:00:00.000Z',
    });
  }
  return { store, tmux, daemon };
}

async function working(store: MemoryEventStore, agentId: string) {
  await store.append({
    entity_type: 'agent', entity_id: agentId, event_type: 'act.prompt_submitted',
    payload: { agent_id: agentId, message_ids: [], content: 'own work', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-19T00:00:01.000Z',
  });
}

async function send(daemon: Daemon, message: string) {
  return daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message,
    ask: false,
    reply: false,
  });
}

async function assertions(store: MemoryEventStore) {
  return (await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted');
}

test('adversarial: verified departure without the target stop never asserts', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  tmux.observeFrameDeparture('palace:W');

  const accepted = await send(daemon, 'departed but unfinished turn');

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});

test('adversarial: a target stop without verified frame departure never asserts', async () => {
  const { store, tmux: _tmux, daemon } = await rig();
  await working(store, 'target');
  // Departure NOT observed: the fake demands evidence, exactly as the real capture does.

  const accepted = await send(daemon, 'staged into a working engine, departure unproven');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});

test('adversarial: departure into an engine not observed working never rides the stop join', async () => {
  const { store, tmux, daemon } = await rig();
  tmux.observeFrameDeparture('palace:W');
  // Target turn is unobserved at send: the missing UserPromptSubmit is missing
  // evidence, not a license for the stop join to speak in its place.

  const accepted = await send(daemon, 'departed with no turn evidence');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});

test('adversarial: a non-staged transport claiming departure never asserts on stop', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  tmux.sendVerifiedToSeat = async () => ({ bytes: 42, verdict: 'submit_failed', frame_departed: true } as never);

  const accepted = await send(daemon, 'departure forged onto a refused transport');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});

test('adversarial: another agent\'s stop never asserts the target\'s pending frame', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  await working(store, 'bystander');
  tmux.observeFrameDeparture('palace:W');

  const accepted = await send(daemon, 'pending on target, bystander stops');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'bystander' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});

test('adversarial: a deduped repeat stop never re-runs the join for later receipts', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });
  tmux.observeFrameDeparture('palace:W');

  // Sent AFTER the turn ended; the engine will submit it as a fresh prompt and
  // only its UserPromptSubmit hook may assert. A repeat stop is deduped and
  // must not read the receipt as consumed by the finished turn.
  const accepted = await send(daemon, 'sent after stop');
  const repeat = await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect(repeat).toMatchObject({ ok: true, deduped: true });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await assertions(store)).toEqual([]);
});
