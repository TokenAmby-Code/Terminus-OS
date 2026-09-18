// Behavioral pins for ask callback correlation. A callback belongs to one
// exact observed comm frame and one later target turn. Delivery, unrelated
// activity, and sender wait policy are not response evidence.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const subscriber = 'subscriber';
const target = { agent_id: 'target', persona: 'orchestrator', seat_id: 'council:orchestrator' };
const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };

async function appendAsk(store: MemoryEventStore, askId: string, messageId: string): Promise<void> {
  const occurred_at = '2026-08-18T00:00:00.000Z';
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted',
    payload: { source_agent_id: subscriber, target_agent_ids: [target.agent_id], targets: [target], ask_id: askId },
    provenance, occurred_at,
  });
  await store.append({
    entity_type: 'ask', entity_id: askId, event_type: 'reg.comm_target_snapshotted',
    payload: { message_id: messageId, targets: [target] }, provenance, occurred_at,
  });
}

async function observe(store: MemoryEventStore, messageId: string, agentId = target.agent_id): Promise<void> {
  await store.append({
    entity_type: 'assertion', entity_id: `comm-observed:${messageId}:${agentId}`,
    event_type: 'act.comm_observed',
    payload: { message_id: messageId, target_agent_id: agentId, receiving_agent_id: agentId, source_agent_id: subscriber },
    provenance, occurred_at: '2026-08-18T00:00:01.000Z',
  });
}

function wait(daemon: Daemon, askId: string, senderCeilingMs = 0) {
  return daemon.waitComm({
    schema_version: SCHEMA_VERSION,
    ask_id: askId,
    subscriber_agent_id: subscriber,
    sender_ceiling_ms: senderCeilingMs,
  });
}

test('behavioral pin: only exact-frame observation makes a later stop callback-eligible', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'exact-ask', 'exact-message');

  await daemon.commStop(target.agent_id, 'unrelated stop output', 'stop-before-observation', null);
  await observe(store, 'another-message');
  await daemon.commStop(target.agent_id, 'activity after another frame', 'stop-after-another-frame', null);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_callback_asserted')).toEqual([]);

  await observe(store, 'exact-message');
  await daemon.commStop(target.agent_id, 'answer after exact consumption', 'stop-after-exact-frame', null);
  expect(await wait(daemon, 'exact-ask')).toMatchObject({
    ask_terminal: true,
    ask_complete: true,
    sender_release: 'ask_terminal',
    callbacks: [{ target, content: 'answer after exact consumption', source: 'stop' }],
    failures: [],
    outstanding: [],
  });
});

test('behavioral pin: a pre-observation stop is never sampled into the post-gate turn', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'turn-ask', 'turn-message');

  await daemon.commStop(target.agent_id, 'pre-gate snapshot', 'pre-gate-stop', null);
  await observe(store, 'turn-message');
  expect(await wait(daemon, 'turn-ask')).toMatchObject({
    ask_terminal: false,
    ask_complete: false,
    sender_release: 'sender_ceiling',
    callbacks: [],
    failures: [],
    outstanding: [target],
  });

  await daemon.commStop(target.agent_id, 'post-gate turn', 'post-gate-stop', null);
  expect(await wait(daemon, 'turn-ask')).toMatchObject({
    ask_terminal: true,
    ask_complete: true,
    sender_release: 'ask_terminal',
    callbacks: [{ content: 'post-gate turn' }],
  });
});

test('behavioral pin: sender ceiling releases the caller without terminalizing the ask', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'patient-ask', 'patient-message');

  expect(await wait(daemon, 'patient-ask')).toMatchObject({
    ask_terminal: false,
    ask_complete: false,
    sender_release: 'sender_ceiling',
    callbacks: [],
    failures: [],
    outstanding: [target],
  });

  await observe(store, 'patient-message');
  await daemon.commStop(target.agent_id, 'eventual answer', 'eventual-stop', null);
  expect(await wait(daemon, 'patient-ask')).toMatchObject({
    ask_terminal: true,
    ask_complete: true,
    sender_release: 'ask_terminal',
    callbacks: [{ content: 'eventual answer' }],
    failures: [],
    outstanding: [],
  });
});

test('behavioral pin: affirmative response impossibility terminalizes without answering', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'failed-ask', 'failed-message');
  await daemon.commStop(target.agent_id, 'output is not impossibility', 'unrelated-stop', null);

  await store.append({
    entity_type: 'assertion', entity_id: 'comm-response-failure:failed-ask:target',
    event_type: 'act.comm_response_failed',
    payload: { ask_id: 'failed-ask', message_id: 'failed-message', target_agent_id: target.agent_id, reason: 'response_target_reset' },
    provenance, occurred_at: '2026-08-18T00:00:02.000Z',
  });

  expect(await wait(daemon, 'failed-ask')).toMatchObject({
    ask_terminal: true,
    ask_complete: false,
    sender_release: 'ask_terminal',
    callbacks: [],
    failures: [{ target, reason: 'response_target_reset' }],
    outstanding: [],
  });
});
