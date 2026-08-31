// Adversarial lane: the turn-stop join records observation ONLY with the full
// evidence chain — staged transport, target working at send, a fresh stop,
// and the exact frame observed ABSENT from a visible composer at that stop.
// Any partial chain stays unobserved, and the exterminated send-time
// departure observation (raced the busy engine's repaint; specimen e5757301)
// stays dead: no runtime surface spells it again.

import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const IDLE_COMPOSER = 'transcript\n\n › \n\nchrome\n';

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const target = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

test('adversarial: the exterminated send-time departure observation has no runtime, contract, or documentation residue', async () => {
  const root = join(import.meta.dir, '../../..');
  const self = import.meta.path;
  const forbidden = [
    'frame_departed',
    'observeFrameDeparture',
    'withholdFrameDeparture',
    'departureObservedSeats',
    'observeComposerFrame',
    'observeShellComposerFrame',
  ];
  const offenders: string[] = [];
  for (const path of await filesBelow(root)) {
    if (path === self || !/\.(?:ts|md|json|sql|yaml|yml)$/.test(path)) continue;
    const text = await Bun.file(path).text();
    if (forbidden.some((name) => text.includes(name))) offenders.push(path.slice(root.length + 1));
  }
  expect(offenders).toEqual([]);
});

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

async function observations(store: MemoryEventStore) {
  return (await store.readAll()).filter((event) => event.event_type === 'act.comm_observed');
}

test('adversarial: no target stop, no assertion — however clear the composer', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  tmux.setPaneText('palace:W', IDLE_COMPOSER);

  const accepted = await send(daemon, 'clear composer, unfinished turn');

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: a frame still painted in the composer at the stop never asserts', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');

  const accepted = await send(daemon, 'interrupted before consumption');
  const receipt = (await store.readAll()).find((event) =>
    event.event_type === 'act.comm_bytes_sent' && event.entity_id === accepted.message_id)!;
  tmux.setPaneText('palace:W', `transcript\n\n › ${String(receipt.payload.rendered_frame).split('\n').join('\n   ')}\n\nchrome\n`);
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: an unobservable pane at the stop proves nothing and never asserts', async () => {
  const { store, daemon } = await rig();
  await working(store, 'target');

  const accepted = await send(daemon, 'no composer evidence at stop');
  // No pane text configured: the fake demands evidence, exactly as the real capture does.
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: a frame staged into an engine not observed working never rides the stop join', async () => {
  const { store, tmux, daemon } = await rig();
  // Target turn is unobserved at send: the missing UserPromptSubmit is missing
  // evidence, not a license for the stop join to speak in its place.
  tmux.setPaneText('palace:W', IDLE_COMPOSER);

  const accepted = await send(daemon, 'no turn evidence at send');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: a non-staged transport never asserts on stop', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  tmux.sendVerifiedToSeat = async () => ({ bytes: 42, verdict: 'submit_failed' } as never);

  const accepted = await send(daemon, 'refused transport');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(false);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: another agent\'s stop never asserts the target\'s pending frame', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  await working(store, 'bystander');
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  tmux.setPaneText('palace:X', IDLE_COMPOSER);

  const accepted = await send(daemon, 'pending on target, bystander stops');
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'bystander' });

  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});

test('adversarial: a deduped repeat stop never re-runs the join for later receipts', async () => {
  const { store, tmux, daemon } = await rig();
  await working(store, 'target');
  tmux.setPaneText('palace:W', IDLE_COMPOSER);
  await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  // Sent AFTER the turn ended; the engine will submit it as a fresh prompt and
  // only its UserPromptSubmit hook may assert. A repeat stop is deduped and
  // must not read the receipt as consumed by the finished turn.
  const accepted = await send(daemon, 'sent after stop');
  const repeat = await daemon.stop({ schema_version: SCHEMA_VERSION, agent_id: 'target' });

  expect(repeat).toMatchObject({ ok: true, deduped: true });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBe(true);
  expect(await observations(store)).toEqual([]);
});
