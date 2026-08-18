import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { commFrameTokens, commTokenForMessageId } from '../src/comm-frame.ts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function registered(
  d: Daemon,
  store: EventStore,
  seat: string,
  identity: string,
  persona: string,
): Promise<void> {
  const launched = await d.launch({
    seat_id: seat,
    schema_version: SCHEMA_VERSION,
    identity,
    persona,
    rank: 'astartes',
    tint: '#111111',
  });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent',
    entity_id: identity,
    event_type: 'reg.agent_registered',
    payload: { persona, rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-18T00:00:00.000Z',
  });
}

async function fixture() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await registered(d, store, 'council:custodes', 'sender-id', 'custodes');
  await registered(d, store, 'palace:W', 'worker-id', 'white-scars');
  return { d, store, tmux };
}

test('the comm frame resolves the sender persona and exact seat while exposing only a compact machine token', async () => {
  const { d, tmux } = await fixture();
  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender-id',
    target: 'worker-id',
    message: 'opaque: {"unicode":"λ"}',
    ask: false,
    reply: false,
  });

  const rendered = tmux.sends('palace:W')[0]!;
  const token = commTokenForMessageId(accepted.message_id);
  expect(rendered).toBe(`[tx comm from custodes at council:custodes #${token}]\nopaque: {"unicode":"λ"}`);
  expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(rendered).not.toContain(accepted.message_id);
  expect(commFrameTokens(rendered)).toEqual([token]);
});

test('a duplicated persona remains ambiguous and produces no transport effect', async () => {
  const { d, store, tmux } = await fixture();
  await registered(d, store, 'palace:E', 'worker-two', 'white-scars');

  await expect(d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender-id',
    target: 'white-scars',
    message: 'must refuse',
    ask: false,
    reply: false,
  })).rejects.toThrow('identity_ambiguous');
  expect(tmux.sends('palace:W')).toEqual([]);
  expect(tmux.sends('palace:E')).toEqual([]);
});

test('the receiving join redeems a token only for its exact snapshotted receiver', async () => {
  const { d, store } = await fixture();
  await registered(d, store, 'palace:E', 'other-id', 'dark-angels');
  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender-id',
    target: 'worker-id',
    message: 'join me',
    ask: false,
    reply: false,
  });
  const token = commTokenForMessageId(accepted.message_id);

  await expect(d.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'other-id',
    comm_tokens: [token],
  })).rejects.toThrow('message_target_mismatch');
  expect((await d.commDelivery(accepted.message_id)).complete).toBeFalse();

  await expect(d.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker-id',
    comm_tokens: ['AAAAAAAAAAAAAAAAAAAAAA'],
  })).rejects.toThrow('message_target_mismatch');
  expect((await d.commDelivery(accepted.message_id)).complete).toBeFalse();

  await expect(d.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker-id',
    comm_tokens: [token],
  })).resolves.toMatchObject({ asserted: [accepted.message_id] });
});

test('concurrent comms receive distinct tokens and one coalesced hook asserts both exactly once', async () => {
  const { d } = await fixture();
  const results = await Promise.all(['one', 'two'].map((message) => d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender-id',
    target: 'worker-id',
    message,
    ask: false,
    reply: false,
  })));
  const [first, second] = results as [Awaited<ReturnType<Daemon['comm']>>, Awaited<ReturnType<Daemon['comm']>>];
  const tokens = [first, second].map(({ message_id }) => commTokenForMessageId(message_id));
  expect(new Set(tokens).size).toBe(2);

  const result = await d.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker-id',
    comm_tokens: tokens,
  });
  expect(result.asserted).toEqual([first.message_id, second.message_id]);
});
