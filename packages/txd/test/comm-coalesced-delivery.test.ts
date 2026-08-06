// A coalesced flush carries every comm the composer queued, and every one of
// them was delivered.
//
// The shapes below are production payloads. On 2026-08-03, `hook.user_prompt_submit`
// events carrying two, three, and four comm frames were recorded on the bus:
// eight stamped workers — white-scars, death-guard, thousand-sons, alpha-legion,
// dark-angels, space-wolves, sons-of-horus, and emperors-children seven times
// over — each received a real `reg.comm_accepted` message inside a flush, read
// it, and had it recorded by txd as never delivered, because the parser stopped
// at the frame that happened to be first.
//
// The message bodies were intact in every one of those prompts. Nothing was
// lost in transport; the ATTESTATION was lost, which is the defect that makes
// a delivery surface lie.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux, type TmuxControlPlane } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { commFrameMessageIds } from '../src/server.ts';

const frame = (id: string, from = '889c6bdc-cb4a-45dd-8acc-bcb01fbb98eb') => `[tx comm ${id} from ${from}]`;
const A = 'd251aa8e-c375-49d2-9c29-71707a245674';
const B = '6327e892-abb4-44da-b840-d9d1ce368d19';
const C = '4b470ef8-eee6-4a1e-9f0a-000000000001';

// ── the parser ───────────────────────────────────────────────────────────────

test('a coalesced flush yields EVERY frame it carried, in order', () => {
  const prompt = [
    frame(A), 'DISPATCH — busd pre/post-tool event spam. P0.', '',
    frame(B), 'STATUS REQUEST from council:custodes.',
  ].join('\n');
  expect(commFrameMessageIds(prompt)).toEqual([A, B]);
});

test('three frames in one flush yield three ids — emperors-children lost two of these', () => {
  const prompt = [frame(A), 'one', frame(B), 'two', frame(C), 'three'].join('\n');
  expect(commFrameMessageIds(prompt)).toEqual([A, B, C]);
});

test('a lone frame still parses, and a natural prompt yields nothing', () => {
  expect(commFrameMessageIds(`${frame(A)}\nbody`)).toEqual([A]);
  expect(commFrameMessageIds('what is the estate doing right now')).toEqual([]);
  expect(commFrameMessageIds(undefined)).toEqual([]);
});

test('CRLF line endings parse identically — the transport is not required to be LF', () => {
  expect(commFrameMessageIds(`${frame(A)}\r\nbody\r\n${frame(B)}\r\nbody`)).toEqual([A, B]);
});

test('a frame quoted mid-line is prose, not a delivery — the line anchor holds', () => {
  expect(commFrameMessageIds(`I was told ${frame(A)} and ignored it`)).toEqual([]);
});

test('the same id twice in one flush asserts once — a quoted repeat is not a second delivery', () => {
  expect(commFrameMessageIds(`${frame(A)}\nbody\n${frame(A)}\nquoted back`)).toEqual([A]);
});

test('a frame that is not the first line is still a delivery', () => {
  // The old parser was anchored to character zero, so a flush whose first line
  // was anything else correlated NOTHING — not even the frame plainly present.
  expect(commFrameMessageIds(`ok, working on it\n${frame(A)}\nbody`)).toEqual([A]);
});

// ── the assertion path ───────────────────────────────────────────────────────

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

async function fixture() {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux());
  await registered(d, store, 'council:custodes', 'sender');
  await registered(d, store, 'palace:W', 'worker');
  const send = async (message: string) => (await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message, ask: false, reply: false,
  })).message_id;
  const asserted = async () => (await store.readAll())
    .filter((e) => e.event_type === 'act.comm_delivery_asserted')
    .map((e) => String(e.payload.message_id));
  return { store, d, send, asserted };
}

test('every message in a coalesced flush gets its own delivery fact', async () => {
  const { d, send, asserted } = await fixture();
  const first = await send('dispatch brief');
  const second = await send('status request');
  expect(await asserted()).toEqual([]);

  const result = await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [first, second] });

  expect(result.asserted).toEqual([first, second]);
  expect(await asserted()).toEqual([first, second]);
});

test('re-delivery of the same flush adds nothing — the assertion is idempotent per message and target', async () => {
  const { d, send, asserted } = await fixture();
  const first = await send('one');
  const second = await send('two');
  await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [first, second] });

  const again = await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [first, second] });

  expect(again.asserted).toEqual([]);
  expect(await asserted()).toEqual([first, second]);
});

test('a busy sender leaves no parked confirmation and hook replay retries the verified injection', async () => {
  const store = new MemoryEventStore();
  const fakeTmux = new FakeTmux();
  const tmux: TmuxControlPlane = fakeTmux;
  const verified = fakeTmux.sendVerifiedToSeat.bind(fakeTmux);
  let senderInteractive = false;
  let confirmationAttempts = 0;
  tmux.sendVerifiedToSeat = async (seatId, correlationId, text, tabAfterPrefix) => {
    if (seatId === 'council:custodes') {
      confirmationAttempts += 1;
      if (!senderInteractive) return { bytes: 0, verdict: 'frame_absent' as const };
    }
    return verified(seatId, correlationId, text, tabAfterPrefix);
  };
  const d = new Daemon(store, tmux);
  await registered(d, store, 'council:custodes', 'sender');
  await registered(d, store, 'palace:W', 'worker');
  const messageId = (await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'brief', ask: false, reply: false,
  })).message_id;

  await expect(d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [messageId] }))
    .rejects.toThrow('delivery_confirmation_not_staged:frame_absent');

  let events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
  expect(events.find((event) => event.event_type === 'act.agent_input_injected'
    && event.payload.input_class === 'delivery_confirmation')?.payload).toMatchObject({
    submit_verdict: 'frame_absent', target_agent_id: 'sender', message_ids: [messageId],
  });
  expect(fakeTmux.sends('council:custodes')).toEqual([]);

  senderInteractive = true;
  await expect(d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [messageId] }))
    .resolves.toMatchObject({ asserted: [] });

  events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.agent_input_injected'
    && event.payload.input_class === 'delivery_confirmation').map((event) => event.payload.submit_verdict))
    .toEqual(['frame_absent', 'staged']);
  expect(confirmationAttempts).toBe(2);
  expect(fakeTmux.sends('council:custodes')).toEqual([
    `[tx comm delivery confirmed ${messageId} target worker]`,
  ]);
});

test("a frame addressed to someone else is skipped in silence, and does not cost the flush its real delivery", async () => {
  const { d, send, asserted } = await fixture();
  const mine = await send('for the worker');

  const result = await d.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'worker',
    message_ids: ['00000000-0000-4000-8000-000000000000', mine],
  });

  expect(result.asserted).toEqual([mine]);
  expect(await asserted()).toEqual([mine]);
});

test('a flush that matched NOTHING is still a deterministic refusal — a daily prompt cannot wedge the lane', async () => {
  const { d } = await fixture();
  await expect(d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [] }))
    .rejects.toThrow('message_target_mismatch');
  await expect(d.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: ['00000000-0000-4000-8000-000000000000'],
  })).rejects.toThrow('message_target_mismatch');
});

// ── phase two, read back ─────────────────────────────────────────────────────

test('delivery is readable per target, and says so only once the fact exists', async () => {
  const { d, send } = await fixture();
  const messageId = await send('brief');

  const before = await d.commDelivery(messageId);
  expect(before.complete).toBe(false);
  expect(before.deliveries).toMatchObject([{ delivered: false, asserted_at: null, assertion_event_id: null }]);
  expect(before.deliveries[0]!.target.seat_id).toBe('palace:W');

  await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [messageId] });

  const after = await d.commDelivery(messageId);
  expect(after.complete).toBe(true);
  expect(after.deliveries[0]).toMatchObject({ delivered: true });
  expect(after.deliveries[0]!.asserted_at).toBeString();
  expect(after.source_agent_id).toBe('sender');
});

test('an unknown message id is unreadable, not an empty delivery report', async () => {
  const { d } = await fixture();
  await expect(d.commDelivery('00000000-0000-4000-8000-000000000000')).rejects.toThrow('message_absent');
});
