// Adversarial lane: the lost-Enter completion must act ONLY on the full
// evidence chain — staged receipt, idle target turn at send, no delivery
// assertion, target still bound and at rest at the deadline, and the EXACT
// frame observed intact in the at-rest composer. Any partial chain drives
// nothing: no blind retry, no second Enter, no mid-turn interference, no
// action on absent or unobservable evidence.
import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon, type CommReceiptRuntime } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const IDLE_COMPOSER = 'transcript\n\n › \n\nchrome\n';

function paintedFrame(messageId: string, message: string): string {
  return `transcript\n\n › [tx comm ${messageId} from sender]\n${message}\n\nchrome\n`;
}

async function rig(opts: { targetAtRest?: boolean } = {}) {
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
  await store.append({
    entity_type: 'agent', entity_id: 'target', event_type: 'act.prompt_submitted',
    payload: { agent_id: 'target', message_ids: [], content: 'own work', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date(now - 30_000).toISOString(),
  });
  if (opts.targetAtRest !== false) {
    await store.append({
      entity_type: 'agent', entity_id: 'target', event_type: 'act.stop_reported',
      payload: {},
      provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: new Date(now - 14_000).toISOString(),
    });
  }
  return {
    daemon, store, tmux,
    advance: (ms: number) => { now += ms; },
    schedules,
    fire: async (index: number) => { await (schedules[index]!.wake() as unknown as Promise<void> | void); },
    drivenEvents: async () => (await store.readAll()).filter((event) => event.event_type === 'act.comm_submit_driven'),
  };
}

test('a frame absent from the at-rest composer at the deadline drives nothing and records nothing', async () => {
  const { daemon, tmux, advance, fire, drivenEvents } = await rig();
  await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'manually cleared', ask: false, reply: false,
  });
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  advance(30_000);
  await fire(0);
  expect(tmux.entersDriven('palace:W')).toBe(0);
  expect(await drivenEvents()).toHaveLength(0);
});

test('an unobservable composer at the deadline drives nothing — absence of evidence is never evidence', async () => {
  const { daemon, tmux, advance, fire, drivenEvents } = await rig();
  await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'unobservable pane', ask: false, reply: false,
  });
  // No pane text configured: the fake proves nothing, exactly like a failed capture.
  advance(30_000);
  await fire(0);
  expect(tmux.entersDriven('palace:W')).toBe(0);
  expect(await drivenEvents()).toHaveLength(0);
});

test('a mid-turn staged receipt never arms the deadline completion — the turn-stop join owns that lane', async () => {
  const { daemon, schedules } = await rig({ targetAtRest: false });
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'mid-turn frame', ask: false, reply: false,
  });
  const receipt = accepted.staged;
  expect(receipt).toBe(true);
  expect(schedules).toHaveLength(0);
});

test('a target that started working again by the deadline gets no Enter even with a lookalike composer', async () => {
  const { daemon, store, tmux, advance, fire, drivenEvents } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'target busy again', ask: false, reply: false,
  });
  // The target submitted OTHER work before the deadline: it is mid-turn, and a
  // capture against a busy engine proves nothing (specimen e5757301).
  await store.append({
    entity_type: 'agent', entity_id: 'target', event_type: 'act.prompt_submitted',
    payload: { agent_id: 'target', message_ids: [], content: 'operator typed something else', session_id: null },
    provenance: { source: 'hook', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  tmux.setPaneText('palace:W', paintedFrame(accepted.message_id, 'target busy again'));
  advance(30_000);
  await fire(0);
  expect(tmux.entersDriven('palace:W')).toBe(0);
  expect(await drivenEvents()).toHaveLength(0);
});

test('the completion fires at most once per receipt: a second wake for the same message drives no second Enter', async () => {
  const { daemon, tmux, advance, schedules, fire, drivenEvents } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'once only', ask: false, reply: false,
  });
  tmux.setPaneText('palace:W', paintedFrame(accepted.message_id, 'once only'));
  advance(30_000);
  await fire(0);
  expect(tmux.entersDriven('palace:W')).toBe(1);
  // Even if the runtime replays the wake, the recorded completion refuses a second drive.
  for (let index = 0; index < schedules.length; index += 1) await fire(index);
  expect(tmux.entersDriven('palace:W')).toBe(1);
  expect(await drivenEvents()).toHaveLength(1);
});

test('a replaced pane generation at the deadline refuses with zero effect', async () => {
  const { daemon, tmux, advance, fire, drivenEvents } = await rig();
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'stale pane', ask: false, reply: false,
  });
  tmux.setPaneText('palace:W', paintedFrame(accepted.message_id, 'stale pane'));
  tmux.forceSeatGeneration('palace:W', 'replaced-generation');
  advance(30_000);
  await fire(0);
  expect(tmux.entersDriven('palace:W')).toBe(0);
  expect(await drivenEvents()).toHaveLength(0);
});
