// Behavioral pins for ask callback correlation. A stop is one lifecycle fact,
// but every ask it satisfies needs its own ask-bound assertion. Historical
// stops must never be inferred into asks that did not exist when they fired.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const subscriber = 'subscriber';
const target = { agent_id: 'target', persona: 'orchestrator', seat_id: 'council:orchestrator' };

async function appendAsk(store: MemoryEventStore, askId: string, messageId: string): Promise<void> {
  const provenance = { source: 'observer' as const, transport_receipt: null, emitter_version: SCHEMA_VERSION };
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

test('behavioral pin: event 45467 historical stop cannot satisfy ask 8074819a created later', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'historical-ask', 'historical-message');
  await daemon.commStop(target.agent_id, 'historical stop content', 'historical-stop', null);

  await appendAsk(store, '8074819a-3c1b-4158-bab1-36e47d9061f2', 'new-message');
  const beforeNewStop = await daemon.waitComm({
    schema_version: SCHEMA_VERSION,
    ask_id: '8074819a-3c1b-4158-bab1-36e47d9061f2',
    subscriber_agent_id: subscriber,
    timeout_ms: 0,
  });

  expect(beforeNewStop).toMatchObject({ complete: false, callbacks: [], outstanding: [target] });

  await daemon.commStop(target.agent_id, 'new stop content', 'new-stop', null);
  const afterNewStop = await daemon.waitComm({
    schema_version: SCHEMA_VERSION,
    ask_id: '8074819a-3c1b-4158-bab1-36e47d9061f2',
    subscriber_agent_id: subscriber,
    timeout_ms: 0,
  });
  expect(afterNewStop).toMatchObject({
    complete: true,
    callbacks: [{ target, content: 'new stop content', source: 'stop' }],
    outstanding: [],
  });
});

test('behavioral pin: one stop creates one ask-correlated assertion for every ask already open', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await appendAsk(store, 'ask-one', 'message-one');
  await appendAsk(store, 'ask-two', 'message-two');

  await daemon.commStop(target.agent_id, 'one lifecycle fact', 'shared-stop', null);

  const assertions = (await store.readAll()).filter((event) => event.event_type === 'act.comm_callback_asserted');
  expect(assertions).toHaveLength(2);
  expect(assertions.map((event) => event.payload.ask_id).sort()).toEqual(['ask-one', 'ask-two']);
  expect(new Set(assertions.map((event) => event.payload.stop_event_id))).toEqual(new Set(['shared-stop']));
});
