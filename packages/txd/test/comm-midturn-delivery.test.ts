// Behavioral-pin lane: mid-turn transport is delivery, while exact engine
// consumption remains independently attested by UserPromptSubmit. A stop or
// composer capture cannot name which frame the engine consumed.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function rig() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, undefined, undefined, null, null, async () => {});
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
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

/** The target's engine is mid-turn: its own prompt was already submitted. */
async function targetWorking(store: MemoryEventStore) {
  await store.append({
    entity_type: 'agent', entity_id: 'target', event_type: 'act.prompt_submitted',
    payload: { agent_id: 'target', comm_tokens: [], content: 'own work', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-19T00:00:01.000Z',
  });
}

test('behavioral pin: a mid-turn staged frame remains unobserved after unrelated stop output', async () => {
  const { store, daemon } = await rig();
  await targetWorking(store);

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'mid-turn frame',
    ask: false,
    reply: false,
  });
  expect(accepted.staged).toBe(true);
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);

  const stop = await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });
  expect(stop).toMatchObject({ ok: true, recorded: true });

  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery.complete).toBe(true);
  const assertions = (await store.readAll()).filter((event) =>
    event.event_type === 'act.comm_observed'
    && event.payload.message_id === accepted.message_id);
  expect(assertions).toEqual([]);
});

test('behavioral pin: the stop join cannot observe a receiver absent from the target snapshot', async () => {
  const { store, daemon } = await rig();
  await targetWorking(store);
  const messageId = crypto.randomUUID();
  const frame = 'snapshot mismatch frame';
  const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: 'sender', source: { persona: 'p', seat_id: 'council:custodes' },
      target_agent_ids: ['target'], targets: [{ agent_id: 'target', seat_id: 'palace:W', persona: 'p' }],
      ask_id: null, reply_to_ask_id: null, kind: 'message', name: null, rendered_frame: frame,
      message: 'contract disagreement',
    }, provenance, occurred_at: '2026-08-19T00:00:02.000Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_target_snapshotted',
    payload: { message_id: messageId, targets: [] }, provenance, occurred_at: '2026-08-19T00:00:02.000Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
    payload: {
      target_agent_id: 'target', seat_id: 'palace:W', bytes: frame.length,
      submit_verdict: 'staged', target_turn: 'working', kind: 'message', name: null,
      rendered_frame: frame,
    }, provenance, occurred_at: '2026-08-19T00:00:03.000Z',
  });

  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await store.readAll()).filter((event) =>
    event.event_type === 'act.comm_observed'
    && event.payload.message_id === messageId)).toEqual([]);
});

// The receipt records transport facts and the target turn only; that no
// send-time departure field exists is pinned by the adversarial sweep in
// comm-midturn-attestation.adversarial.test.ts, the one place the corpse may
// be remembered.
test('behavioral pin: the bytes-sent receipt records the target turn at send', async () => {
  const { store, daemon } = await rig();
  await targetWorking(store);

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'observed frame',
    ask: false,
    reply: false,
  });

  const receipt = (await store.readAll()).find((event) =>
    event.event_type === 'act.comm_bytes_sent' && event.entity_id === accepted.message_id);
  expect(receipt?.payload).toMatchObject({
    submit_verdict: 'staged',
    target_turn: 'working',
  });
});

test('behavioral pin: repeated stops never synthesize exact-frame observation', async () => {
  const { store, daemon } = await rig();
  await targetWorking(store);
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'slow-consumed frame',
    ask: false,
    reply: false,
  });

  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_observed')).toEqual([]);

  await targetWorking(store);
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_observed')).toEqual([]);
  const receipts = (await store.readAll()).filter((event) =>
    event.event_type === 'act.comm_bytes_sent' && event.entity_id === accepted.message_id);
  expect(receipts).toHaveLength(1); // reconciled to confirmed with no duplicate send
});

test('behavioral pin: the idle-target UserPromptSubmit hook join is unchanged', async () => {
  const { daemon } = await rig();

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'idle frame',
    ask: false,
    reply: false,
  });
  const hook = await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'target',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
  });

  expect(hook.observed).toEqual([accepted.message_id]);
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
});

test('behavioral pin: a hook-asserted observation remains singular after a later stop', async () => {
  const { store, daemon } = await rig();
  await targetWorking(store);

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'double-attested frame',
    ask: false,
    reply: false,
  });
  await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'target',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
  });
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  const assertions = (await store.readAll()).filter((event) =>
    event.event_type === 'act.comm_observed'
    && event.payload.message_id === accepted.message_id);
  expect(assertions).toHaveLength(1);
});
