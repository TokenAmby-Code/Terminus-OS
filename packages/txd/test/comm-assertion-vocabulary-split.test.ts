// Behavioral-pin lane: transport delivery and engine observation are two facts.

import { expect, test } from 'bun:test';
import { EVENT_TYPES, SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const PROV = { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION } as const;

async function bind(daemon: Daemon, store: MemoryEventStore, seat: string, agent: string) {
  await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity: agent, persona: agent, tint: '#111111' });
  await store.append({
    entity_type: 'agent', entity_id: agent, event_type: 'reg.agent_registered',
    payload: { persona: agent, rank: 'astartes', commander: null }, provenance: PROV,
    occurred_at: '2026-08-31T00:00:00.000Z',
  });
}

test('behavioral pin: staged injection asserts transport delivery before engine interaction', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await bind(daemon, store, 'council:custodes', 'sender');
  await bind(daemon, store, 'palace:W', 'idle-target');

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'idle-target',
    message: 'injected but unobserved', ask: false, reply: false,
  });

  expect(accepted.staged).toBe(true);
  expect(await daemon.commDelivery(accepted.message_id)).toMatchObject({ complete: true, resolved: true });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id)).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.comm_observed'
    && event.payload.message_id === accepted.message_id)).toEqual([]);
});

test('behavioral pin: engine pickup appends one comm observation without reasserting delivery', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await bind(daemon, store, 'council:custodes', 'sender');
  await bind(daemon, store, 'palace:W', 'target');
  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'target',
    message: 'observe later', ask: false, reply: false,
  });

  await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'target',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
  });
  await daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'target',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
  });

  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === accepted.message_id)).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.comm_observed'
    && event.payload.message_id === accepted.message_id)).toHaveLength(1);
});

test('behavioral pin: boot reconciles a historical staged receipt and leaves terminal refusal history untouched', async () => {
  expect(EVENT_TYPES).toContain('act.comm_observed');
  const store = new MemoryEventStore();
  const messageId = crypto.randomUUID();
  const target = { agent_id: 'historical-target', seat_id: 'palace:W', persona: 'worker' };
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted',
    payload: { source_agent_id: 'sender', targets: [target], target_agent_ids: [target.agent_id], ask_id: null },
    provenance: PROV, occurred_at: '2026-08-30T00:00:00.000Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_target_snapshotted',
    payload: { message_id: messageId, targets: [target] }, provenance: PROV,
    occurred_at: '2026-08-30T00:00:00.001Z',
  });
  await store.append({
    entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
    payload: { target_agent_id: target.agent_id, seat_id: target.seat_id, bytes: 42, submit_verdict: 'staged' },
    provenance: PROV, occurred_at: '2026-08-30T00:00:00.002Z',
  });
  await store.append({
    entity_type: 'assertion', entity_id: 'historical-refusal', event_type: 'act.comm_delivery_failed',
    payload: { message_id: 'older-message', target_agent_id: 'older-target', reason: 'historical' },
    provenance: PROV, occurred_at: '2026-08-01T00:00:00.000Z',
  });

  const daemon = new Daemon(store, new FakeTmux());
  await daemon.constructEstate();

  expect(await daemon.commDelivery(messageId)).toMatchObject({ complete: true, resolved: true });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.comm_delivery_asserted'
    && event.payload.message_id === messageId)).toHaveLength(1);
  expect(events.filter((event) => event.entity_id === 'historical-refusal'
    && event.event_type === 'act.comm_delivery_failed')).toHaveLength(1);
});
