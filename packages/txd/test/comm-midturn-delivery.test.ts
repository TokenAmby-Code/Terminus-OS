// Behavioral-pin lane: mid-turn comm delivery truth is the staged transport
// fact joined with engine attestation. A frame staged into a WORKING engine
// produces no UserPromptSubmit (live specimens 994854e0, b9c1ca52, 2a243960;
// e5757301 pinned the send-time observation racing the busy engine's repaint),
// so the join reads its evidence when the target's own stop lands: the engine
// is at rest, and a visible composer that no longer holds the exact frame
// proves the frame left it into the turn the stop attests complete. The idle
// path keeps its UserPromptSubmit hook join unchanged.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const IDLE_COMPOSER = 'transcript\n\n › \n\nchrome\n';

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
    payload: { agent_id: 'target', message_ids: [], content: 'own work', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-19T00:00:01.000Z',
  });
}

test('behavioral pin: a mid-turn staged frame absent from the composer at the target stop asserts delivery', async () => {
  const { store, tmux, daemon } = await rig();
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
  // No UserPromptSubmit fires for a frame queued into a working session; the
  // receipt alone never means delivered.
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);

  // At the stop the engine paints its idle composer, the frame long consumed.
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  const stop = await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });
  expect(stop).toMatchObject({ ok: true, recorded: true });

  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery.complete).toBe(true);
  const assertion = (await store.readAll()).find((event) =>
    event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id);
  expect(assertion?.payload).toMatchObject({
    message_id: accepted.message_id,
    target_agent_id: 'target',
    source_agent_id: 'sender',
    attestation: 'turn_stop',
  });
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

test('behavioral pin: a frame the first stop could not clear asserts on a later fresh stop that can', async () => {
  const { store, tmux, daemon } = await rig();
  await targetWorking(store);
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'slow-consumed frame',
    ask: false,
    reply: false,
  });

  // First stop: the pane is unobservable — no evidence, no assertion.
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);

  // The engine works again, then stops with the frame verifiably gone.
  await targetWorking(store);
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
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
    message_ids: [accepted.message_id],
  });

  expect(hook.asserted).toEqual([accepted.message_id]);
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
});

test('behavioral pin: a hook-asserted delivery is not re-asserted by the later stop join', async () => {
  const { store, tmux, daemon } = await rig();
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
    message_ids: [accepted.message_id],
  });
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  const assertions = (await store.readAll()).filter((event) =>
    event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id);
  expect(assertions).toHaveLength(1);
});
