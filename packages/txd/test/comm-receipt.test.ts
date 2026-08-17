// Behavioral-pin lane: the ruled two-tier tx comm receipt rendezvous.
import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon, type CommReceiptRuntime } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux, type TmuxControlPlane } from '../src/tmux.ts';

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
  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', message_ids: [accepted.message_id] });
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

  await daemon.promptSubmitted({ schema_version: SCHEMA_VERSION, agent_id: 'target', message_ids: [accepted.message_id] });
  expect(tmux.sends('council:custodes')).toEqual([
    `[tx comm delivery confirmed ${accepted.message_id} target target]`,
  ]);
  expect((await store.readAll()).filter((event) => event.payload.input_class === 'delivery_confirmation')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ message_ids: [accepted.message_id], submit_verdict: 'staged' }) }),
  ]);
});

test('behavioral pin: a draft-present zero-byte send is an immediate honest transport refusal', async () => {
  const { daemon, tmux, scheduledMs } = await rig();
  const control: TmuxControlPlane = tmux;
  control.sendVerifiedToSeat = async () => ({ bytes: 0, verdict: 'composer_draft_present' as const });
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'target',
    message: 'must fail loud',
    ask: false,
    reply: false,
  });

  const receipt = await daemon.waitCommReceipt({
    schema_version: SCHEMA_VERSION,
    message_id: accepted.message_id,
    source_agent_id: 'sender',
  });

  expect(receipt).toMatchObject({
    ok: false,
    phase: 'transport_refused',
    bytes_sent: 0,
    submit_verdict: 'composer_draft_present',
  });
  expect(scheduledMs()).toBeUndefined();
});
