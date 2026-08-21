// Behavioral-pin lane: the idle-target lost-Enter completion (live specimen
// 29fb6cc0, Custodes → Fabricator-General, 2026-08-19). tmux exit 0 proves the
// Enter keypress was handed to the pane, never that the engine consumed it; a
// frame staged into an AWAITING_INPUT engine whose Enter has no effect
// produces no UserPromptSubmit and no later stop, so neither the hook join nor
// the turn-stop join ever re-examines it — the frame sat painted for ~104s
// until a manual Enter. The persisted tier-1 receipt deadline is the derived
// activation: at that moment, an unasserted staged idle-target receipt earns
// ONE composer-at-rest observation, and an exact intact frame — the payload
// observably staged, the submit leg observably failed — completes its own
// transaction with one driven Enter. Delivery is still asserted only by the
// engine's real UserPromptSubmit.
import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon, type CommReceiptRuntime } from '../src/core.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const IDLE_COMPOSER = 'transcript\n\n › \n\nchrome\n';

/** The exact painted state the Emperor witnessed: frame intact, un-submitted. */
function paintedFrame(messageId: string, message: string): string {
  return `transcript\n\n › [tx comm from p at council:custodes #${commTokenForMessageId(messageId)}]\n${message}\n\nchrome\n`;
}

async function rig() {
  let now = Date.parse('2026-08-19T20:26:13.000Z');
  const schedules: Array<{ wake: () => void; delayMs: number }> = [];
  const runtime: CommReceiptRuntime = {
    now: () => now,
    schedule: (wake, delayMs) => { schedules.push({ wake, delayMs }); return () => {}; },
  };
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, () => new Date(now).toISOString(), undefined, null, null, async () => {}, undefined, runtime);
  for (const [seat, identity] of [['council:custodes', 'sender'], ['palace:W', 'target']] as const) {
    await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', tint: '#1' });
    await store.append({
      entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
      payload: { persona: 'p', rank: 'astartes', commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: new Date(now).toISOString(),
    });
  }
  // The target is at rest: one completed turn, exactly like FG at seq 56405.
  await store.append({
    entity_type: 'agent', entity_id: 'target', event_type: 'act.prompt_submitted',
    payload: { agent_id: 'target', comm_tokens: [], content: 'own work', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date(now - 30_000).toISOString(),
  });
  await store.append({
    entity_type: 'agent', entity_id: 'target', event_type: 'act.stop_reported',
    payload: {},
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date(now - 14_000).toISOString(),
  });
  return {
    daemon, store, tmux,
    advance: (ms: number) => { now += ms; },
    schedules,
    fire: async (index: number) => { await (schedules[index]!.wake() as unknown as Promise<void> | void); },
  };
}

test('behavioral pin: a staged idle-target frame still intact at the receipt deadline is completed by one driven Enter and a typed event', async () => {
  const { daemon, store, tmux, advance, schedules, fire } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'post-pinch acknowledgement', ask: false, reply: false,
  });
  expect(accepted.staged).toBe(true);
  // The exact specimen state: bytes staged, receipt says awaiting_input, and
  // the engine never fires UserPromptSubmit because the Enter had no effect.
  const receipt = (await store.readAll()).find((event) =>
    event.event_type === 'act.comm_bytes_sent' && event.entity_id === accepted.message_id);
  expect(receipt?.payload).toMatchObject({ submit_verdict: 'staged', target_turn: 'awaiting_input' });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);

  // One wake armed at the persisted tier-1 ceiling — never a novel interval.
  expect(schedules.map((row) => row.delayMs)).toEqual([30_000]);

  // At the deadline the frame demonstrably still sits in the at-rest composer.
  tmux.setPaneText('palace:W', paintedFrame(accepted.message_id, 'post-pinch acknowledgement'));
  advance(30_000);
  await fire(0);

  expect(tmux.entersDriven('palace:W')).toBe(1);
  const driven = (await store.readAll()).filter((event) => event.event_type === 'act.comm_submit_driven');
  expect(driven).toHaveLength(1);
  expect(driven[0]?.payload).toMatchObject({
    message_id: accepted.message_id,
    target_agent_id: 'target',
    seat_id: 'palace:W',
    frame_observation: 'frame_present',
  });

  // The driven Enter is transport, not delivery: still undelivered until the
  // engine's own UserPromptSubmit attests it.
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', comm_tokens: [commTokenForMessageId(accepted.message_id)] });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
});

test('behavioral pin: a frame the engine consumed before the deadline drives nothing', async () => {
  const { daemon, store, tmux, advance, fire } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'consumed normally', ask: false, reply: false,
  });
  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', comm_tokens: [commTokenForMessageId(accepted.message_id)] });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);

  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  advance(30_000);
  await fire(0);

  expect(tmux.entersDriven('palace:W')).toBe(0);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_submit_driven')).toHaveLength(0);
});
