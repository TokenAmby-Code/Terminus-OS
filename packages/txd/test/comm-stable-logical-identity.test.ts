// Behavioral-pin lane: a stable perpetual-seat identity is never the rotating
// agent instance that happens to occupy it. Resolution must cross the stable
// seat only through a currently routable instance; a retired instance is not
// a target even while its seat-cleared fact has not yet folded.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { acceptCommIdentity } from '../src/comm-identity.ts';
import { commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const provenance = {
  source: 'observer' as const,
  transport_receipt: null,
  emitter_version: SCHEMA_VERSION,
};

async function registered(
  daemon: Daemon,
  store: EventStore,
  seatId: string,
  agentId: string,
  persona: string,
): Promise<void> {
  const launch = await daemon.launch({
    schema_version: SCHEMA_VERSION,
    seat_id: seatId,
    identity: agentId,
    persona,
    rank: 'astartes',
    tint: '#111111',
  });
  if (!launch.ok) throw new Error(`fixture launch failed: ${launch.reason}`);
  await store.append({
    entity_type: 'agent',
    entity_id: agentId,
    event_type: 'reg.agent_registered',
    payload: { persona, rank: 'astartes', commander: null },
    provenance,
    occurred_at: '2026-08-25T18:00:00.000Z',
  });
}

test('a perpetual persona label is constructed as its stable logical seat identity', () => {
  expect(acceptCommIdentity('Pax')).toEqual({
    kind: 'stable_seat',
    seat_id: 'council:pax',
  });
  expect(acceptCommIdentity('COUNCIL:PAX')).toEqual({
    kind: 'stable_seat',
    seat_id: 'council:pax',
  });
});

test('a stable perpetual identity cannot snapshot a retired occupant', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await registered(daemon, store, 'palace:W', 'sender', 'blood-angels');
  await registered(daemon, store, 'council:pax', 'pax-instance-old', 'pax');
  await store.append({
    entity_type: 'agent',
    entity_id: 'pax-instance-old',
    event_type: 'reg.retired',
    payload: {},
    provenance,
    occurred_at: '2026-08-25T18:01:00.000Z',
  });

  await expect(daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'pax',
    message: 'must have no transport effect',
    ask: false,
    reply: false,
  })).rejects.toThrow('comm_target_unresolvable: pax; softened_forms=["pax","council:pax"]');

  const events = await store.readAll();
  expect(events.some((event) => event.event_type === 'reg.comm_target_snapshotted')).toBeFalse();
  expect(events.some((event) => String(event.event_type) === 'reg.comm_refused')).toBeTrue();
  expect(tmux.sends('council:pax')).toEqual([]);
});

test('a stable perpetual snapshot records logical seat and rotating delivery instance separately', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await registered(daemon, store, 'palace:W', 'sender', 'blood-angels');
  await registered(daemon, store, 'council:pax', 'pax-instance-current', 'pax');

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'pax',
    message: 'identity contract',
    ask: false,
    reply: false,
  });

  expect(accepted.targets).toEqual([{
    logical_identity: { kind: 'stable_seat', seat_id: 'council:pax' },
    agent_id: 'pax-instance-current',
    seat_id: 'council:pax',
    persona: 'pax',
  }]);
  const snapshot = (await store.readAll()).find((event) =>
    event.event_type === 'reg.comm_target_snapshotted');
  expect(snapshot?.payload.targets).toEqual(accepted.targets);
});

test('a retired generation cannot redeem a stable identity snapshot resolved to its successor', async () => {
  const store = new MemoryEventStore();
  const daemon = new Daemon(store, new FakeTmux());
  await registered(daemon, store, 'palace:W', 'sender', 'blood-angels');
  await registered(daemon, store, 'council:pax', 'pax-instance-old', 'pax');
  await store.appendAll([
    {
      entity_type: 'agent', entity_id: 'pax-instance-old', event_type: 'reg.retired', payload: {},
      provenance, occurred_at: '2026-08-25T18:01:00.000Z',
    },
    {
      entity_type: 'seat', entity_id: 'council:pax', event_type: 'reg.process_reaped',
      payload: { agent_id: 'pax-instance-old' }, provenance, occurred_at: '2026-08-25T18:01:00.000Z',
    },
    {
      entity_type: 'seat', entity_id: 'council:pax', event_type: 'reg.seat_cleared', payload: {},
      provenance, occurred_at: '2026-08-25T18:01:00.000Z',
    },
  ]);
  await registered(daemon, store, 'council:pax', 'pax-instance-new', 'pax');

  const accepted = await daemon.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'pax',
    message: 'successor only',
    ask: false,
    reply: false,
  });
  const comm_tokens = [commTokenForMessageId(accepted.message_id)];

  await expect(daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'pax-instance-old',
    comm_tokens,
  })).rejects.toThrow('message_target_mismatch');
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBeFalse();

  await expect(daemon.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'pax-instance-new',
    comm_tokens,
  })).resolves.toMatchObject({ asserted: [accepted.message_id] });
  expect((await daemon.commDelivery(accepted.message_id)).complete).toBeTrue();
});
