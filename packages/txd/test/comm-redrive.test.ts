// The belt-and-suspenders half of the two-phase comm contract: a comm whose
// bytes were staged but whose submit fact never arrived is re-driven through
// txd's own pane mechanism, or its failure is made loud to the sender. Nothing
// here waits: WHEN a redrive fires is lifecycled's decision; this is the
// mechanism plane only.
//
// On 2026-08-04, three codex composers held comms unsubmitted for hours (one
// visibly character-corrupted by the send-keys race) and the Emperor pressed
// Enter by hand, twice. The corrupted composer is why redrive verifies the
// payload before driving Enter: submitting mangled text is worse than failing
// loudly.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux, RealTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';

async function registered(d: Daemon, store: EventStore, seat: string, identity: string): Promise<void> {
  const launched = await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', rank: 'astartes', tint: '#111111' });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
  await store.append({
    entity_type: 'seat', entity_id: seat, event_type: 'reg.bound',
    payload: {
      agent_id: identity, persona: 'p', rank: 'astartes', commander: null,
      tint: '#111111', pane_generation: 'fake-generation', engine: 'codex',
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.001Z',
  });
  await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.002Z',
  });
}

async function fixture() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await registered(d, store, 'council:custodes', 'sender');
  await registered(d, store, 'palace:W', 'worker');
  const send = async (message: string) => (await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message, ask: false, reply: false,
  })).message_id;
  const events = async (type: string) => (await store.readAll()).filter((e) => e.event_type === type);
  return { store, tmux, d, send, events };
}

const frame = (id: string, body: string) => `[tx comm ${id} from sender]\n${body}`;

// ── the composer verdict (pure, pinned without tmux) ─────────────────────────

test('an intact parked frame is redrivable', () => {
  const id = 'd251aa8e-c375-49d2-9c29-71707a245674';
  const pane = `some transcript above\n› [tx comm ${id} from sender]\n  read the orders file and begin.\n`;
  expect(RealTmux.composerVerdict(pane, id, frame(id, 'read the orders file and begin.'))).toBe('intact');
});

test('a character-corrupted frame is NOT redrivable — Enter would submit mangled text', () => {
  const id = 'd251aa8e-c375-49d2-9c29-71707a245674';
  // The imperial-fists exhibit: characters substituted mid-typing.
  const pane = `› [tx comm ${id} from sender]\n  read the ordnrs file and begin.\n`;
  expect(RealTmux.composerVerdict(pane, id, frame(id, 'read the orders file and begin.'))).toBe('corrupted');
});

test('a pane without the frame yields absent — nothing safe to submit', () => {
  const id = 'd251aa8e-c375-49d2-9c29-71707a245674';
  expect(RealTmux.composerVerdict('just a shell prompt\n$ ', id, frame(id, 'body'))).toBe('absent');
});

test('composer chrome and wrapping do not read as corruption', () => {
  const id = 'd251aa8e-c375-49d2-9c29-71707a245674';
  const pane = [
    `│ › [tx comm ${id} from sender]`,
    '│   read the orders file',
    '│   and begin.',
  ].join('\n');
  expect(RealTmux.composerVerdict(pane, id, frame(id, 'read the orders file and begin.'))).toBe('intact');
});

test('behavioral pin: a narrow pane may wrap inside the frame id and payload words', () => {
  const id = 'd251aa8e-c375-49d2-9c29-71707a245674';
  const pane = [
    '│ › [tx comm d251aa8e-c375-',
    '│   49d2-9c29-71707a245674 from',
    '│   sender]',
    '│   read the ord',
    '│   ers file and begin.',
  ].join('\n');
  expect(RealTmux.composerVerdict(pane, id, frame(id, 'read the orders file and begin.'))).toBe('intact');
});

// ── the redrive mechanism ────────────────────────────────────────────────────

test('redrive on an intact parked frame drives Enter once and attests it', async () => {
  const { tmux, d, send, events } = await fixture();
  const id = await send('read the orders file and begin.');
  tmux.setPaneText('palace:W', `› ${frame(id, 'read the orders file and begin.')}`);

  const result = await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  expect(result.outcome).toBe('enter_redriven');
  expect(tmux.redriveEnters('palace:W')).toBe(1);
  const attempts = await events('act.comm_redrive_attempted');
  expect(attempts.length).toBe(1);
  expect(attempts[0]!.payload.outcome).toBe('enter_redriven');
});

test('behavioral pin: a composer-quiet fact may redrive one intact rendered intent without retyping', async () => {
  const { store, tmux, d, events } = await fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  await store.append({
    entity_type: 'message', entity_id: id, event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: 'sender', target_agent_ids: ['worker'], targets: [], ask_id: null,
      kind: 'skill', name: 'openai-docs', rendered_frame: '$openai-docs models',
      message: '$openai-docs models', intent: { kind: 'skill', name: 'openai-docs', args: ['models'] },
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-06T00:00:00.000Z',
  });
  tmux.setPaneText('palace:W', 'skills palette chrome\n› $openai-docs models');

  const result = await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  expect(result.outcome).toBe('enter_redriven');
  expect(tmux.redriveEnters('palace:W')).toBe(1);
  expect((await events('act.comm_redrive_attempted'))[0]?.payload.outcome).toBe('enter_redriven');
});

test('redrive after the assertion already exists is a no-op that never touches the pane', async () => {
  const { tmux, d, send, events } = await fixture();
  const id = await send('already home');
  await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [id] });
  tmux.setPaneText('palace:W', `› ${frame(id, 'already home')}`);

  const result = await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  expect(result.outcome).toBe('already_delivered');
  expect(tmux.redriveEnters('palace:W')).toBe(0);
  expect((await events('act.comm_redrive_attempted')).length).toBe(0);
});

test('redrive on a corrupted composer refuses to drive Enter and says why', async () => {
  const { tmux, d, send } = await fixture();
  const id = await send('read the orders file and begin.');
  tmux.setPaneText('palace:W', `› [tx comm ${id} from sender]\n  read the ordnrs file and begin.`);

  const result = await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  expect(result.outcome).toBe('composer_corrupted');
  expect(tmux.redriveEnters('palace:W')).toBe(0);
});

test('redrive when the frame is nowhere visible does not type anything', async () => {
  const { tmux, d, send } = await fixture();
  const id = await send('vanished');
  tmux.setPaneText('palace:W', 'an ordinary shell prompt');

  const result = await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  expect(result.outcome).toBe('frame_absent');
  expect(tmux.redriveEnters('palace:W')).toBe(0);
});

test('a late organic submit after a redrive asserts exactly once', async () => {
  const { store, tmux, d, send } = await fixture();
  const id = await send('raced');
  tmux.setPaneText('palace:W', `› ${frame(id, 'raced')}`);
  await d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'worker' });

  await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [id] });
  await d.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'worker', message_ids: [id] }).catch(() => undefined);

  const assertions = (await store.readAll()).filter((e) => e.event_type === 'act.comm_delivery_asserted');
  expect(assertions.length).toBe(1);
});

test('redrive refuses an unknown message or a non-target', async () => {
  const { d, send } = await fixture();
  const id = await send('real');
  await expect(d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: '00000000-0000-4000-8000-000000000000', target_agent_id: 'worker' }))
    .rejects.toThrow('message_absent');
  await expect(d.commRedrive({ schema_version: SCHEMA_VERSION, message_id: id, target_agent_id: 'sender' }))
    .rejects.toThrow('target_mismatch');
});

test('behavioral pin: operator recovery finds and submits the exact retained FG command specimen', async () => {
  const { store, tmux, d, events } = await fixture();
  const messageId = '34766e7c-9e06-4a9c-b12a-52ca5f6d440f';
  const rendered = '/message PR153 recovery milestone verified in txd journal: old author retired seq 50946; old pane reaped/seat cleared 50947-50948; hot pre-cutover txd emitted legacy reg.seat_decommissioned 50949; exact preserved dispatch 7fcb44af began 50952 and fresh agent 498b534e bound/registered on mechanicus:1339c621 generation 657aec66 at 50959-50961. No failed comm/run retry and no second lane. Session continuity appended at Perpetuals/Custodes/Reports/reconciliation-canon-hardening-2026-08-17.md (ob seq 3933). PR153 remains the sole cutover lane; legacy fact at 50949 is live proof deployment is still owed.';
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted',
    payload: {
      source_agent_id: 'sender', target_agent_ids: ['worker'], targets: [], ask_id: null,
      kind: 'command', name: 'message', rendered_frame: rendered, message: rendered,
      intent: { kind: 'command', name: 'message', args: rendered.slice('/message '.length).split(' ') },
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-18T19:10:24.426Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
    payload: {
      target_agent_id: 'worker', seat_id: 'palace:W', bytes: 605,
      submit_verdict: 'seat_unresolved', kind: 'command', name: 'message', rendered_frame: rendered,
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-18T19:10:35.043Z',
  });
  tmux.setPaneText('palace:W', `› ${rendered}`);

  const result = await d.commRecover({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    discard_corrupted: false,
  });

  expect(result).toMatchObject({ ok: true, message_id: messageId, outcome: 'enter_redriven' });
  expect(tmux.redriveEnters('palace:W')).toBe(1);
  expect((await events('act.comm_redrive_attempted')).at(-1)?.payload).toMatchObject({
    message_id: messageId, trigger: 'operator_recovery', source_agent_id: 'sender', outcome: 'enter_redriven',
  });
});

test('behavioral pin: corrupted recovery discards only when explicitly requested and journals the lost frame', async () => {
  const { store, tmux, d, send, events } = await fixture();
  const id = await send('retained original bytes');
  const sent = (await store.readAll()).find((event) => event.entity_id === id && event.event_type === 'act.comm_bytes_sent')!;
  sent.payload.submit_verdict = 'seat_unresolved';
  tmux.setPaneText('palace:W', '› retained original bytex');

  const refused = await d.commRecover({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', discard_corrupted: false });
  expect(refused.outcome).toBe('composer_corrupted');
  expect(await events('act.comm_draft_discarded')).toHaveLength(0);

  const discarded = await d.commRecover({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', discard_corrupted: true });
  expect(discarded.outcome).toBe('discarded');
  expect((await events('act.comm_draft_discarded')).at(-1)?.payload).toMatchObject({
    message_id: id, bytes: sent.payload.bytes, source_agent_id: 'sender', outcome: 'discarded',
  });
});

test('behavioral pin: a post-mutation submit failure immediately redrives the retained frame', async () => {
  const { tmux, d, events } = await fixture();
  const control = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string): Promise<{ bytes: number; verdict: 'seat_unresolved' }>;
  };
  control.sendVerifiedToSeat = async (seat, _id, text) => {
    tmux.setPaneText(seat, `› ${text}`);
    return { bytes: Buffer.byteLength(text), verdict: 'seat_unresolved' };
  };

  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    message: 'post-mutation recovery specimen', ask: false, reply: false,
  });

  expect(tmux.redriveEnters('palace:W')).toBe(1);
  expect((await events('act.comm_redrive_attempted')).at(-1)?.payload).toMatchObject({
    message_id: accepted.message_id, target_agent_id: 'worker', trigger: 'retained_after_send', outcome: 'enter_redriven',
  });
});

test('behavioral pin: a draft-present send enqueues whole and drains on the existing redrive edge', async () => {
  const { tmux, d, events } = await fixture();
  const original = tmux.sendVerifiedToSeat.bind(tmux);
  let occupied = true;
  const control = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string, tabAfter?: string, engine?: 'claude' | 'codex'):
      Promise<{ bytes: number; verdict: 'staged' | 'seat_unresolved' | 'composer_draft_present' }>;
  };
  control.sendVerifiedToSeat = async (seat, id, text, tabAfter, engine) => occupied
    ? { bytes: 0, verdict: 'composer_draft_present' as const }
    : original(seat, id, text, tabAfter, engine);

  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    message: 'queued transaction drains whole', ask: false, reply: false,
  });
  expect(tmux.sends('palace:W')).toEqual([]);

  occupied = false;
  tmux.setPaneText('palace:W', '› ');
  const drained = await d.commRedrive({
    schema_version: SCHEMA_VERSION, message_id: accepted.message_id, target_agent_id: 'worker',
  });

  expect(drained.outcome).toBe('enter_redriven');
  expect(tmux.sends('palace:W')).toEqual([frame(accepted.message_id, 'queued transaction drains whole')]);
  expect((await events('act.comm_bytes_sent')).at(-1)?.payload).toMatchObject({
    target_agent_id: 'worker', submit_verdict: 'staged', drain: true,
  });
});
