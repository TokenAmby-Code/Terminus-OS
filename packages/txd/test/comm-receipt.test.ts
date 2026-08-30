// Behavioral-pin lane: the ruled two-tier tx comm receipt rendezvous.
import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon, type CommReceiptRuntime } from '../src/core.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function rig() {
  let now = Date.parse('2026-08-15T17:00:00.000Z');
  let expire!: () => void;
  let scheduledMs: number | undefined;
  let scheduled!: () => void;
  const scheduledPromise = new Promise<void>((resolve) => { scheduled = resolve; });
  const runtime: CommReceiptRuntime = {
    now: () => now,
    schedule: (wake, delayMs) => { expire = wake; scheduledMs = delayMs; scheduled(); return () => {}; },
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
  return {
    daemon, store, tmux,
    advance: (ms: number) => { now += ms; },
    waitScheduled: () => scheduledPromise,
    scheduledMs: () => scheduledMs,
    expire: () => expire(),
  };
}

test('tier 1 resolves directly from the attestation event and emits no follow-up input', async () => {
  const { daemon, store, tmux } = await rig();
  const accepted = await daemon.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target', message: 'on time', ask: false, reply: false });
  const pending = daemon.waitCommReceipt({ schema_version: SCHEMA_VERSION, message_id: accepted.message_id, source_agent_id: 'sender' });
  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', comm_tokens: [commTokenForMessageId(accepted.message_id)] });
  expect(await pending).toMatchObject({ phase: 'delivery_confirmed', message_id: accepted.message_id });
  expect(tmux.sends('council:custodes')).toEqual([]);
  expect((await store.readAll()).filter((event) => event.payload.input_class === 'delivery_confirmation')).toHaveLength(0);
});

test('tier 2 returns bytes sent at the bound, then a late attestation emits a receipted follow-up', async () => {
  const { daemon, store, tmux, advance, waitScheduled, scheduledMs, expire } = await rig();
  const accepted = await daemon.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target', message: 'late', ask: false, reply: false });
  const pending = daemon.waitCommReceipt({ schema_version: SCHEMA_VERSION, message_id: accepted.message_id, source_agent_id: 'sender' });
  await waitScheduled();
  expect(scheduledMs()).toBe(30_000);
  advance(30_000);
  expire();
  expect(await pending).toMatchObject({ phase: 'bytes_sent', message_id: accepted.message_id, staged: true });

  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', comm_tokens: [commTokenForMessageId(accepted.message_id)] });
  expect(tmux.sends('council:custodes')).toEqual([
    `[tx comm delivery confirmed ${accepted.message_id} target target]`,
  ]);
  expect((await store.readAll()).filter((event) => event.payload.input_class === 'delivery_confirmation')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ message_ids: [accepted.message_id], submit_verdict: 'staged' }) }),
  ]);
});

test('a replayed frame after delivery assertion records one deduped fact and never injects a late confirmation', async () => {
  // Production shape from 2026-08-29: the first prompt submission asserted
  // delivery (txd.events 98884-98889). The target engine later replayed the
  // identical frame after the tier-1 bound (99159), with no new comm event.
  // That external replay is a receipt to reconcile, not a second delivery.
  const { daemon, store, tmux, advance } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'orientation frame',
    ask: false,
    reply: false,
  });
  const frame = {
    schema_version: SCHEMA_VERSION,
    agent_id: 'target',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
    content: 'identical already-delivered orientation frame',
  };

  expect(await daemon.promptSubmitted(frame)).toMatchObject({ asserted: [accepted.message_id] });
  advance(30_000);
  expect(await daemon.promptSubmitted(frame)).toMatchObject({ asserted: [] });

  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id)).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.receipt_deduped'
    && event.payload.of === 'comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id)).toHaveLength(1);
  expect(events.filter((event) => event.payload.input_class === 'delivery_confirmation'
    && Array.isArray(event.payload.message_ids)
    && event.payload.message_ids.includes(accepted.message_id))).toHaveLength(0);
  expect(tmux.sends('council:custodes')).toEqual([]);
});

test('a throwing admission observer cannot abort the already-committed transport', async () => {
  const { daemon, tmux } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'observer isolation',
    ask: false,
    reply: false,
  }, null, () => { throw new Error('observer disconnected'); });
  expect(accepted.staged).toBe(true);
  expect(tmux.sends('palace:W')).toHaveLength(1);
});

test('a restarted daemon terminalizes an admitted transport that has no active operation or receipt rows', async () => {
  const { daemon, store, tmux } = await rig();
  let transportStarted!: () => void;
  const started = new Promise<void>((resolve) => { transportStarted = resolve; });
  let releaseTransport!: () => void;
  const held = new Promise<void>((resolve) => { releaseTransport = resolve; });
  tmux.sendVerifiedToSeat = async () => {
    transportStarted();
    await held;
    throw new Error('old process ended');
  };
  let admission!: { message_id: string };
  const oldProcess = daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'restart recovery',
    ask: false,
    reply: false,
  }, null, (value) => { admission = value; });
  await started;

  const restarted = new Daemon(store, tmux);
  try {
    expect(await restarted.waitCommReceipt({
      schema_version: SCHEMA_VERSION,
      message_id: admission.message_id,
      source_agent_id: 'sender',
    })).toMatchObject({
      ok: false,
      phase: 'transport_refused',
      message_id: admission.message_id,
      submit_verdict: 'transport_failed',
    });
  } finally {
    releaseTransport();
    await oldProcess;
  }
});
