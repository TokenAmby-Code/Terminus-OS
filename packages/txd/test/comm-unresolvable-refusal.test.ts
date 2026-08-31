// Behavioral-pin lane: a comm identity that survives the funnel mouth but
// resolves to no current binding refuses loudly and leaves a durable fact.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KNOWN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = '2026-08-31T00:25:00.000Z';
const provenance = {
  source: 'observer' as const,
  transport_receipt: null,
  emitter_version: SCHEMA_VERSION,
};

async function register(
  daemon: Daemon,
  store: MemoryEventStore,
  seatId: string,
  agentId: string,
  persona: string,
): Promise<void> {
  const launched = await daemon.launch({
    schema_version: SCHEMA_VERSION,
    seat_id: seatId,
    identity: agentId,
    persona,
    rank: 'astartes',
    tint: '#111111',
  });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent',
    entity_id: agentId,
    event_type: 'reg.agent_registered',
    payload: { persona, rank: 'astartes', commander: null },
    provenance,
    occurred_at: NOW,
  });
}

async function rig() {
  const store = new MemoryEventStore(() => NOW);
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, () => NOW);
  await register(daemon, store, 'palace:W', SOURCE, 'blood-angels');
  await register(daemon, store, 'palace:N', KNOWN, 'white-scars');
  await register(daemon, store, 'palace:S', DEAD, 'iron-hands');
  await store.append({
    entity_type: 'agent',
    entity_id: DEAD,
    event_type: 'reg.retired',
    payload: {},
    provenance,
    occurred_at: NOW,
  });
  return { daemon, store, tmux };
}

const send = (daemon: Daemon, target: string) => daemon.comm({
  schema_version: SCHEMA_VERSION,
  source_agent_id: SOURCE,
  target,
  message: 'ping',
  ask: false,
  reply: false,
});

test('unknown persona refuses with its attempted target, softened forms, and a durable fact', async () => {
  const { daemon, store, tmux } = await rig();

  await expect(send(daemon, 'imperial-fists')).rejects.toThrow(
    'comm_target_unresolvable: imperial-fists; softened_forms=["imperial-fists"]',
  );

  const refusal = (await store.readAll()).find((event) =>
    String(event.event_type) === 'reg.comm_refused');
  expect(refusal?.payload).toEqual({
    reason: 'comm_target_unresolvable',
    source_agent_id: SOURCE,
    attempted_target: 'imperial-fists',
    softened_forms: ['imperial-fists'],
  });
  expect(tmux.sends('palace:N')).toEqual([]);
});

test('the comm endpoint returns the typed refusal and its durable event id', async () => {
  const { daemon, store } = await rig();
  const server = makeServer({ bind: '127.0.0.1', port: 0, daemon, machine: 'test' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/agents/comm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        source_agent_id: SOURCE,
        target: 'imperial-fists',
        message: 'ping',
        ask: false,
        reply: false,
      }),
    });
    expect(response.status).toBe(422);
    const body = await response.json() as Record<string, unknown>;
    const refusal = (await store.readAll()).find((event) =>
      String(event.event_type) === 'reg.comm_refused');
    expect(body).toEqual({
      ok: false,
      error: 'comm_target_unresolvable',
      attempted_target: 'imperial-fists',
      softened_forms: ['imperial-fists'],
      refusal_event_id: refusal?.seq,
    });
  } finally {
    server.stop(true);
  }
});

test('known persona delivery is unchanged and records no admission refusal', async () => {
  const { daemon, store } = await rig();

  const accepted = await send(daemon, 'white-scars');

  expect(accepted.ok).toBeTrue();
  expect(accepted.targets).toHaveLength(1);
  expect(accepted.targets[0]).toMatchObject({
    agent_id: KNOWN,
    seat_id: 'palace:N',
    persona: 'white-scars',
  });
  expect((await store.readAll()).some((event) =>
    String(event.event_type) === 'reg.comm_refused')).toBeFalse();
});

test('a dead incarnation exact agent id keeps identity_absent and records no name refusal', async () => {
  const { daemon, store } = await rig();

  await expect(send(daemon, DEAD)).rejects.toThrow(`identity_absent: ${DEAD}`);

  expect((await store.readAll()).some((event) =>
    String(event.event_type) === 'reg.comm_refused')).toBeFalse();
});
