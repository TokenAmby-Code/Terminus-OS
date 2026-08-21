// Behavioral-pin lane: every staged comm resolves to a delivered fact or a
// loud refusal. Two live defects are pinned here.
//
// 1. The draft-prefixed submission. txd stages a comm frame into a composer
//    that already holds an operator draft, so the pasted frame continues that
//    draft's line. The engine submits the whole composer and the comm IS
//    delivered — the hook's own content carries the frame byte for byte — but
//    the line-anchored frame parser hands `promptSubmitted` an empty
//    `message_ids`, and the delivery is recorded as never made. Live specimen
//    (2026-08-19, worker -> council:custodes): message
//    9dc15225-9eb1-4de5-8de7-4a5315c6089b staged at event 56994 21:55:54.768Z,
//    submitted at event 56995 21:55:55.014Z with content
//    `im going to wait until home from the gym to do the [tx comm 9dc15225…]`
//    and `message_ids: []`. Seven of the twenty comms left unattested that
//    night are this exact shape; five of the seven were addressed to Custodes.
//    The staged frame found intact inside the submitted prompt is the observed
//    effect, and it is what the join must read.
//
// 2. The silent third state. A comm staged to a target whose binding then ends
//    can never be delivered, and txd recorded nothing at all for it: no
//    assertion, no refusal. `tx comm delivery` answered `delivered: false`
//    forever, which is the same answer it gives for a message still in flight,
//    so a sender could not tell dropped from pending. `act.comm_delivery_failed`
//    is in the admitted contract union and 1334 rows of it sit in the journal
//    (last written 2026-08-06) with no emitter left in the runtime.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const PROV = { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION } as const;
const T = '2026-08-19T21:55:54.000Z';

// The live specimen's draft: an operator sentence with no trailing newline, so
// the frame txd pastes continues that same line.
const OPERATOR_DRAFT = 'im going to wait until home from the gym to do the ';

async function rig() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  for (const [seat, identity, persona, rank] of [
    ['palace:W', 'worker', 'black-shields', 'astartes'],
    ['council:custodes', 'custodes', 'custodes', 'overseer'],
    ['palace:N', 'bystander', 'black-shields', 'astartes'],
  ] as const) {
    const launched = await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona, rank, tint: '#111111' });
    if (!launched.ok) throw new Error(`rig bind failed: ${launched.reason}`);
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona, rank, commander: null }, provenance: PROV, occurred_at: T,
    });
  }
  return { store, tmux, daemon };
}

/** The exact bytes txd staged into the target's composer for this message. */
async function stagedFrame(store: MemoryEventStore, messageId: string): Promise<string> {
  const receipt = (await store.readAll()).find((event) =>
    event.event_type === 'act.comm_bytes_sent' && event.entity_id === messageId);
  return String(receipt!.payload.rendered_frame);
}

test('a staged frame the engine submitted behind an operator draft asserts delivery', async () => {
  const { store, daemon } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'worker', target: 'custodes',
    message: 'GITHUBD DEAD-HEAD FOLD DEADLOCK — REPAIRED, LANDED, CONVERGED.', ask: false, reply: false,
  });
  expect(accepted.staged).toBe(true);
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);

  // The engine's own UserPromptSubmit, shaped exactly as event 56995 was: the
  // draft runs straight into the frame, so the frame parser names nothing.
  const submitted = await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'custodes', message_ids: [],
    content: `${OPERATOR_DRAFT}${await stagedFrame(store, accepted.message_id)}`,
  });
  expect(submitted.asserted).toEqual([accepted.message_id]);

  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery.complete).toBe(true);
  expect(delivery.deliveries[0]).toMatchObject({ delivered: true, failed: false });
});

test('a staged frame quoted by an agent it was never staged to asserts nothing', async () => {
  const { store, daemon } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'worker', target: 'custodes',
    message: 'for custodes alone', ask: false, reply: false,
  });
  // A bystander pastes the same frame into its own prompt. The frame proves
  // delivery only to the composer txd staged it into.
  await expect(daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'bystander', message_ids: [],
    content: `look at this: ${await stagedFrame(store, accepted.message_id)}`,
  })).rejects.toThrow('message_target_mismatch');
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
});

test('a comm staged to a target that is then closed resolves to a loud refusal', async () => {
  const { store, daemon } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', target: 'worker',
    message: 'report your leg', ask: false, reply: false,
  });
  expect((await daemon.commDelivery(accepted.message_id)).resolved).toBe(false);

  const closed = await daemon.close({ schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', targets: ['worker'] });
  expect(closed).toMatchObject({ ok: true });

  const failure = (await store.readAll()).find((event) => event.event_type === 'act.comm_delivery_failed');
  expect(failure?.payload).toMatchObject({
    message_id: accepted.message_id,
    target_agent_id: 'worker',
    source_agent_id: 'custodes',
    reason: 'delivery_target_closed',
  });

  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery.resolved).toBe(true);
  expect(delivery.complete).toBe(false);
  expect(delivery.deliveries[0]).toMatchObject({ delivered: false, failed: true, failure_reason: 'delivery_target_closed' });
});

test('a delivered comm is never refused by the target closing afterwards', async () => {
  const { store, daemon } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', target: 'worker',
    message: 'delivered before close', ask: false, reply: false,
  });
  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [accepted.message_id] });
  await daemon.close({ schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', targets: ['worker'] });

  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_failed')).toEqual([]);
  const delivery = await daemon.commDelivery(accepted.message_id);
  expect(delivery).toMatchObject({ complete: true, resolved: true });
});

test('the sender waiting on a receipt is told the refusal, not bytes sent', async () => {
  const { daemon } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', target: 'worker',
    message: 'racing the close', ask: false, reply: false,
  });
  const pending = daemon.waitCommReceipt({
    schema_version: SCHEMA_VERSION, message_id: accepted.message_id, source_agent_id: 'custodes',
  });
  await daemon.close({ schema_version: SCHEMA_VERSION, source_agent_id: 'custodes', targets: ['worker'] });
  expect(await pending).toMatchObject({
    ok: false, phase: 'delivery_failed', message_id: accepted.message_id,
  });
});
