// The pre-send comm watch: the committed obligation in lifecycled's contract
// (its `context` field names txd's send path as the live caller) made true.
// txd arms a one-shot prompt_submitted subscription carrying the comm
// message_id BEFORE the bytes go to the pane, so named composer-quiet facts
// can permit verified redrives when the submit fact has not arrived.
//
// Arming failure is loud and leaves the pane untouched: once the gate is the
// safety boundary, bypassing it would restore the newborn dead-zone race.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore, type EventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon, type CommWatchArmInput } from '../src/core.ts';
import { commFrame, commTokenForMessageId } from '../src/comm-frame.ts';

async function registered(d: Daemon, store: EventStore, seat: string, identity: string): Promise<void> {
  const launched = await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'p', rank: 'astartes', tint: '#111111' });
  if (!launched.ok) throw new Error(`fixture launch failed: ${launched.reason}`);
  await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
}

async function bindEngine(store: EventStore, tmux: FakeTmux, seat: string, identity: string, engine: 'claude' | 'codex'): Promise<void> {
  const paneGeneration = await tmux.seatGeneration(seat);
  if (!paneGeneration) throw new Error(`fixture pane absent: ${seat}`);
  await store.append({
    entity_type: 'seat', entity_id: seat, event_type: 'reg.bound',
    payload: { agent_id: identity, persona: 'p', rank: 'astartes', commander: null, tint: '#111111', pane_generation: paneGeneration, engine },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
  await store.append({
    entity_type: 'agent', entity_id: identity, event_type: 'reg.agent_registered',
    payload: { persona: 'p', rank: 'astartes', commander: null },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-08-01T00:00:00.000Z',
  });
}

async function fixture(
  arm: ((input: CommWatchArmInput) => Promise<void>) | null,
  physical: ConstructorParameters<typeof Daemon>[4] = null,
) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux, undefined, undefined, physical, null, arm);
  await registered(d, store, 'council:custodes', 'sender');
  await registered(d, store, 'palace:W', 'worker');
  return { store, tmux, d };
}

test('behavioral pin: a painted newborn backfills durable composer interactivity before its comm gate', async () => {
  const order: string[] = [];
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const physical = {
    machine: 'test',
    configuration: { generation: 'g', digest: 'd' },
    agentWrapper: '/wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: string, payload: Record<string, unknown>) => {
      order.push(`publish:${type}`);
      published.push({ type, payload });
    },
  };
  const armed: CommWatchArmInput[] = [];
  const { store, tmux, d } = await fixture(async (input) => { order.push('gate'); armed.push(input); }, physical);
  tmux.setPaneText('palace:W', '› Write tests for @filename\n\n  gpt-5.6-sol medium');
  const observe = tmux.observeComposerInteractive.bind(tmux);
  tmux.observeComposerInteractive = async (seatId) => {
    order.push(`observe:${seatId}`);
    return observe(seatId);
  };

  await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'newborn control',
    ask: false,
    reply: false,
  });

  await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'idle control',
    ask: false,
    reply: false,
  });

  expect(order).toEqual([
    'observe:palace:W',
    'publish:agent.composer_interactive',
    'gate',
    'observe:palace:W',
    'gate',
  ]);
  expect(armed.map((input) => input.composer_interactive_observed)).toEqual([true, true]);
  expect(published[0]?.payload).toMatchObject({
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker',
    seat_id: 'palace:W',
  });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.composer_observation_prepared')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.composer_interactive_announced')).toHaveLength(1);
});

test('behavioral pin: concurrent comms publish one composer observation per pane generation', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const physical = {
    machine: 'test',
    configuration: { generation: 'g', digest: 'd' },
    agentWrapper: '/wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const { store, tmux, d } = await fixture(async () => undefined, physical);
  tmux.setPaneText('palace:W', '› Write tests for @filename\n\n  gpt-5.6-sol medium');
  const observe = tmux.observeComposerInteractive.bind(tmux);
  let observations = 0;
  let releaseObservations!: () => void;
  const observationsReady = new Promise<void>((resolve) => { releaseObservations = resolve; });
  tmux.observeComposerInteractive = async (seatId) => {
    observations += 1;
    if (observations === 2) releaseObservations();
    await observationsReady;
    return observe(seatId);
  };

  await Promise.all([
    d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'one', ask: false, reply: false }),
    d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'two', ask: false, reply: false }),
  ]);

  expect(published.filter((event) => event.type === 'agent.composer_interactive')).toHaveLength(1);
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.composer_observation_prepared')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'act.composer_interactive_announced')).toHaveLength(1);
});

test('behavioral pin: a pane rebind after observation cannot publish stale composer interactivity', async () => {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const physical = {
    machine: 'test',
    configuration: { generation: 'g', digest: 'd' },
    agentWrapper: '/wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const { store, tmux, d } = await fixture(async () => undefined, physical);
  tmux.setPaneText('palace:W', '› Write tests for @filename\n\n  gpt-5.6-sol medium');
  const observe = tmux.observeComposerInteractive.bind(tmux);
  tmux.observeComposerInteractive = async (seatId) => {
    const interactive = await observe(seatId);
    await store.append({
      entity_type: 'seat', entity_id: seatId, event_type: 'reg.bound',
      payload: { agent_id: 'worker', persona: 'p', rank: 'astartes', commander: null, tint: '#111111', pane_generation: 'replacement-generation', engine: 'codex' },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-01T00:00:01.000Z',
    });
    return interactive;
  };

  await expect(d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'stale generation control',
    ask: false,
    reply: false,
  })).rejects.toThrow('target_binding_changed: worker');

  expect(published.filter((event) => event.type === 'agent.composer_interactive')).toHaveLength(0);
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.composer_observation_prepared')).toHaveLength(0);
  expect(events.filter((event) => event.event_type === 'act.composer_interactive_announced')).toHaveLength(0);
});

test('behavioral pin: an unpainted newborn receives no bytes before lcd releases its composer-interactive gate', async () => {
  const order: string[] = [];
  const armed: CommWatchArmInput[] = [];
  let release!: () => void;
  let gateStarted!: () => void;
  const started = new Promise<void>((resolve) => { gateStarted = resolve; });
  const composerInteractive = new Promise<void>((resolve) => { release = resolve; });
  const { tmux, d } = await fixture(async (input) => {
    order.push(`gate:${input.target_agent_id}`);
    armed.push(input);
    gateStarted();
    await composerInteractive;
  });
  const original = tmux.sendVerifiedToSeat.bind(tmux);
  tmux.sendVerifiedToSeat = async (seatId, id, text) => { order.push(`send:${seatId}`); return original(seatId, id, text); };

  const pending = d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'watch me', ask: false, reply: false });
  await started;

  expect(order).toEqual(['gate:worker']);
  expect(tmux.sends('palace:W')).toEqual([]);
  // Waiting on lifecycle truth must not monopolize txd's single-writer lock.
  await expect(d.clipboardPush({ schema_version: SCHEMA_VERSION, buffer_name: 'tx-clipboard' }))
    .resolves.toMatchObject({ buffer_name: 'tx-clipboard' });
  release();
  const accepted = await pending;
  expect(order).toEqual(['gate:worker', 'send:palace:W']);
  expect(armed).toEqual([{
    message_id: accepted.message_id,
    target_agent_id: 'worker',
    source_agent_id: 'sender',
    composer_interactive_observed: false,
  }]);
});

test('a dead readiness plane fails loud before bytes and attests the unarmed gap', async () => {
  const { store, tmux, d } = await fixture(async () => { throw new Error('lifecycled unreachable'); });

  await expect(d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'still goes', ask: false, reply: false }))
    .rejects.toThrow('lifecycled unreachable');

  expect(tmux.sends('palace:W')).toEqual([]);
  const unarmed = (await store.readAll()).filter((e) => e.event_type === 'act.comm_watch_unarmed');
  expect(unarmed.length).toBe(1);
  expect(unarmed[0]!.payload.target_agent_id).toBe('worker');
});

test('behavioral pin: durable admission is exposed before a rejecting comm watch is armed', async () => {
  let admission: { message_id: string } | undefined;
  const { store, tmux, d } = await fixture(async () => {
    if (!admission) throw new Error('watch armed before durable admission was exposed');
    throw new Error('lifecycled unreachable after admission');
  });

  await expect(d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'admit before watch',
    ask: false,
    reply: false,
  }, null, (accepted) => { admission = accepted; })).rejects.toThrow('lifecycled unreachable after admission');

  expect(tmux.sends('palace:W')).toEqual([]);
  expect(admission?.message_id).toBeString();
  const receipt = await d.waitCommReceipt({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    message_id: admission!.message_id,
  });
  expect(receipt).toMatchObject({
    ok: false,
    phase: 'transport_refused',
    message_id: admission!.message_id,
    submit_verdict: 'transport_failed',
  });
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_bytes_sent'))
    .toHaveLength(1);
});

test('behavioral pin: every new ordinary message receipt is typed while historical payloads remain readable', async () => {
  const { store, d } = await fixture(async () => undefined);
  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    message: 'typed receipt', ask: false, reply: false,
  });
  const events = await store.readAll();
  expect(events.find((event) => event.event_type === 'act.comm_bytes_sent')?.payload).toMatchObject({
    kind: 'message', name: null,
    rendered_frame: commFrame(accepted.message_id, { persona: 'p', seat_id: 'council:custodes' }, 'typed receipt'),
  });
  // Journal payloads are open dumb facts: old immutable rows with no new
  // typing fields remain readable instead of being rewritten or rejected.
  await store.append({
    entity_type: 'message', entity_id: 'historical', event_type: 'act.comm_bytes_sent',
    payload: { target_agent_id: 'worker', bytes: 3, submit_verdict: 'staged' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: '2026-07-01T00:00:00.000Z',
  });
  expect((await store.readAll()).find((event) => event.entity_id === 'historical')?.payload.kind).toBeUndefined();
});

test('behavioral pin: a multi-KB opaque comm stages whole and asserts only on its submit hook', async () => {
  const { store, tmux, d } = await fixture(async () => undefined);
  const message = `first line\n${"quoted='yes' Unicode Ω 漢字 🛡️\n".repeat(256)}last line`;

  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message,
    ask: false,
    reply: false,
  });

  const expectedFrame = commFrame(accepted.message_id, { persona: 'p', seat_id: 'council:custodes' }, message);
  expect(tmux.sends('palace:W')).toEqual([expectedFrame]);
  expect((await store.readAll()).find((event) => event.event_type === 'act.comm_bytes_sent')?.payload)
    .toMatchObject({
      bytes: Buffer.byteLength(expectedFrame),
      rendered_frame: expectedFrame,
      submit_verdict: 'staged',
    });
  expect((await d.commDelivery(accepted.message_id)).complete).toBe(false);

  await d.promptSubmitted({
    schema_version: SCHEMA_VERSION,
    agent_id: 'worker',
    comm_tokens: [commTokenForMessageId(accepted.message_id)],
    content: expectedFrame,
  });

  expect((await d.commDelivery(accepted.message_id)).complete).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted'))
    .toHaveLength(1);
});

test('behavioral pin: prompt-submit admission cannot wait behind composer staging', async () => {
  // Event 37076 staged the Pax frame while txd held its global journal lock.
  // Edge-proxy delivered the resulting UserPromptSubmit hook, but its txd
  // consumer timed out because promptSubmitted could not acquire that lock.
  const { store, tmux, d } = await fixture(async () => undefined);
  let hookReturned = false;
  tmux.sendVerifiedToSeat = async (_seat, messageId, frame) => {
    const result = await d.promptSubmitted({
      schema_version: SCHEMA_VERSION,
      agent_id: 'worker',
      comm_tokens: [commTokenForMessageId(messageId)],
      content: frame,
    });
    hookReturned = true;
    expect(result.asserted).toEqual([]);
    return { bytes: Buffer.byteLength(frame), verdict: 'staged' as const };
  };

  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'hook must cross while staging is in flight',
    ask: false,
    reply: false,
  });

  expect(hookReturned).toBe(true);
  expect((await d.commDelivery(accepted.message_id)).complete).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted'))
    .toHaveLength(1);
}, 500);

test('behavioral pin: a replaced pane generation refuses before comm bytes cross the transport boundary', async () => {
  let tmux!: FakeTmux;
  const f = await fixture(async () => {
    tmux.forceSeatGeneration('palace:W', 'replacement-generation');
  });
  tmux = f.tmux;

  const accepted = await f.d.comm({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'sender',
    target: 'worker',
    message: 'must stay on the bound pane generation',
    ask: false,
    reply: false,
  });

  expect(accepted.staged).toBe(false);
  expect(tmux.sends('palace:W')).toEqual([]);
  expect((await f.store.readAll()).find((event) => event.event_type === 'act.comm_bytes_sent')?.payload)
    .toMatchObject({ bytes: 0, submit_verdict: 'seat_unresolved' });
});

for (const [journalEvent, claimedBytes] of [
  [49482, 93],
  [49776, 564],
  [50898, 1219],
  [53046, 1465],
  [53084, 903],
] as const) {
  test(`behavioral pin: event ${journalEvent} unresolved adapter bytes can never become journal truth`, async () => {
    const { store, tmux, d } = await fixture(async () => undefined);
    tmux.sendVerifiedToSeat = async () => ({ bytes: claimedBytes, verdict: 'seat_unresolved' as const });

    const accepted = await d.comm({
      schema_version: SCHEMA_VERSION,
      source_agent_id: 'sender',
      target: 'worker',
      message: `event ${journalEvent} recurrence`,
      ask: false,
      reply: false,
    });

    expect(accepted.staged).toBe(false);
    expect((await store.readAll()).find((event) => event.event_type === 'act.comm_bytes_sent')?.payload)
      .toMatchObject({ bytes: 0, submit_verdict: 'seat_unresolved' });
  });
}

test('machine-feed injection shares the composer gate and carries no comm envelope', async () => {
  const { store, tmux } = await fixture(null);
  const order: string[] = [];
  const d = new Daemon(store, tmux, undefined, undefined, null, null, null, async (input) => {
    order.push(`gate:${input.target_agent_id}`);
  });
  const original = tmux.sendVerifiedToSeat.bind(tmux);
  tmux.sendVerifiedToSeat = async (seat, id, text) => {
    order.push(`inject:${seat}`);
    expect(text).toBe('machine fact');
    expect(text).not.toContain('tx comm');
    return original(seat, id, text);
  };

  const response = await d.inject({ schema_version: SCHEMA_VERSION, target_agent_id: 'worker', text: 'machine fact' });

  expect(response).toEqual({ ok: true, target_agent_id: 'worker', deferred: true });
  expect(order).toEqual(['gate:worker', 'inject:palace:W']);
});

test('machine-feed injection refuses a non-staged transport so the bus event is redelivered', async () => {
  const { store, tmux } = await fixture(null);
  const d = new Daemon(store, tmux, undefined, undefined, null, null, null, async () => undefined);
  const refusingTmux = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string): Promise<{ bytes: number; verdict: 'transport_failed' }>;
  };
  refusingTmux.sendVerifiedToSeat = async (_seat, _id, text) => ({
    bytes: Buffer.byteLength(text, 'utf8'),
    verdict: 'transport_failed',
  });

  await expect(d.inject({ schema_version: SCHEMA_VERSION, target_agent_id: 'worker', text: 'durable machine fact' }))
    .rejects.toThrow('machine_feed_not_staged: transport_failed');

  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'act.agent_input_injected')).toHaveLength(1);
  expect(events.find((event) => event.event_type === 'act.agent_input_injected')?.payload.submit_verdict)
    .toBe('transport_failed');
  expect(events.some((event) => event.event_type.startsWith('reg.comm_'))).toBe(false);
});

for (const profile of [
  { engine: 'claude', kind: 'command', name: 'compact', args: ['hard'], rendered: '/compact hard', tabAfter: '/compact' },
  { engine: 'codex', kind: 'skill', name: 'openai-docs', args: ['models'], rendered: '$openai-docs models', tabAfter: '$openai-docs' },
] as const) {
  test(`behavioral pin: ${profile.engine} intent renders in txd, types Tab, and writes a typed receipt`, async () => {
    const { store, tmux, d } = await fixture(async () => undefined);
    await bindEngine(store, tmux, 'palace:W', 'worker', profile.engine);
    const observed: unknown[] = [];
    const instrumented = tmux as unknown as {
      sendVerifiedToSeat(seat: string, id: string, text: string, tabAfter?: string): Promise<{ bytes: number; verdict: 'staged' }>;
    };
    instrumented.sendVerifiedToSeat = async (seat, id, text, tabAfter) => {
      observed.push({ seat, id, text, tabAfter });
      return { bytes: Buffer.byteLength(text), verdict: 'staged' };
    };

    const accepted = await d.comm({
      schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
      intent: { kind: profile.kind, name: profile.name, args: [...profile.args] }, ask: false, reply: false,
    } as never);
    expect(observed).toEqual([{ seat: 'palace:W', id: accepted.message_id, text: profile.rendered, tabAfter: profile.tabAfter }]);
    const events = await store.readAll();
    expect(events.find((event) => event.event_type === 'act.comm_bytes_sent')?.payload).toMatchObject({
      kind: profile.kind, name: profile.name, rendered_frame: profile.rendered, submit_verdict: 'staged',
    });

    // Command surfaces may complete without a model turn, but the literal
    // prompt_submitted hook must still correlate the rendered frame and create
    // one terminal assertion without a comm envelope message id.
    await d.promptSubmitted({
      schema_version: SCHEMA_VERSION, agent_id: 'worker', comm_tokens: [], content: profile.rendered,
    });
    const delivery = await d.commDelivery(accepted.message_id);
    expect(delivery.complete).toBe(true);
    expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
  });
}

// Enter is driven outside the journal mutex, so the engine's UserPromptSubmit
// can reach txd before `act.comm_bytes_sent` exists. A command surface submits
// with no comm envelope in the prompt, so that hook carries an empty
// `comm_tokens` list and only the rendered frame identifies it. Correlating the
// send path by message id alone loses the delivery permanently: the hook finds
// no staged transport yet and declines to assert, and the staged receipt then
// finds no id to match. Both facts exist and the delivery still reads undelivered.
test('behavioral pin: a hook that beats the staged receipt still asserts the intent delivery', async () => {
  const { store, tmux, d } = await fixture(async () => undefined);
  await bindEngine(store, tmux, 'palace:W', 'worker', 'claude');
  const rendered = '/compact hard';
  const instrumented = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string, tabAfter?: string): Promise<{ bytes: number; verdict: 'staged' }>;
  };
  instrumented.sendVerifiedToSeat = async (_seat, _id, text) => {
    await d.promptSubmitted({
      schema_version: SCHEMA_VERSION, agent_id: 'worker', comm_tokens: [], content: rendered,
    });
    return { bytes: Buffer.byteLength(text), verdict: 'staged' };
  };

  const accepted = await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    intent: { kind: 'command', name: 'compact', args: ['hard'] }, ask: false, reply: false,
  } as never);

  const delivery = await d.commDelivery(accepted.message_id);
  expect(delivery.complete).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
});

// The rendered frame names an intent only while one intent carries it. Two
// identical sends to one target share a frame byte for byte, so a hook with an
// empty `comm_tokens` list cannot say which of them the engine submitted.
// Attributing it to whichever was found first would assert delivery for a
// message that was never submitted — the exact `UserPromptSubmit` join has to
// stay one-to-one. An ambiguous hook is non-delivery evidence: it asserts
// nothing and consumes nothing.
test('behavioral pin: identical intent frames to one target assert neither without a unique witness', async () => {
  const { store, tmux, d } = await fixture(async () => undefined);
  await bindEngine(store, tmux, 'palace:W', 'worker', 'claude');
  const rendered = '/compact hard';
  const instrumented = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string, tabAfter?: string): Promise<{ bytes: number; verdict: 'staged' }>;
  };
  instrumented.sendVerifiedToSeat = async (_seat, _id, text) => ({ bytes: Buffer.byteLength(text), verdict: 'staged' });
  const send = async () => (await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    intent: { kind: 'command', name: 'compact', args: ['hard'] }, ask: false, reply: false,
  } as never)).message_id;

  const first = await send();
  const second = await send();

  await expect(d.promptSubmitted({
    schema_version: SCHEMA_VERSION, agent_id: 'worker', comm_tokens: [], content: rendered,
  })).rejects.toThrow('message_target_mismatch');

  expect((await d.commDelivery(first)).complete).toBe(false);
  expect((await d.commDelivery(second)).complete).toBe(false);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(0);
});

// Uniqueness has to be a stable property of the accepted intents, not of the
// ones still awaiting assertion. If delivered messages drop out of the
// candidate set, that set shrinks as deliveries land: the first of two
// identical intents asserts, the second becomes the only survivor, and the
// spent hook that named the first then reads as a unique witness for a message
// the engine never submitted. A hook is spent once it has asserted.
test('behavioral pin: a spent intent hook does not assert the next identical intent', async () => {
  const { store, tmux, d } = await fixture(async () => undefined);
  await bindEngine(store, tmux, 'palace:W', 'worker', 'claude');
  const rendered = '/compact hard';
  const instrumented = tmux as unknown as {
    sendVerifiedToSeat(seat: string, id: string, text: string, tabAfter?: string): Promise<{ bytes: number; verdict: 'staged' }>;
  };
  let hookPending = true;
  instrumented.sendVerifiedToSeat = async (_seat, _id, text) => {
    if (hookPending) {
      hookPending = false;
      await d.promptSubmitted({
        schema_version: SCHEMA_VERSION, agent_id: 'worker', comm_tokens: [], content: rendered,
      });
    }
    return { bytes: Buffer.byteLength(text), verdict: 'staged' };
  };
  const send = async () => (await d.comm({
    schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker',
    intent: { kind: 'command', name: 'compact', args: ['hard'] }, ask: false, reply: false,
  } as never)).message_id;

  const first = await send();
  expect((await d.commDelivery(first)).complete).toBe(true);

  const second = await send();

  expect((await d.commDelivery(second)).complete).toBe(false);
  expect((await store.readAll()).filter((event) => event.event_type === 'act.comm_delivery_asserted')).toHaveLength(1);
});

// ── Delivery attempts first: a gate TRANSPORT failure is not a verdict ──────
//
// The comm doctrine (2026-08-19): delivery attempts come first and the effect
// is post-validated; an unasserted delivery remains ok:false. A slow or
// unreachable lifecycled is a transport fact about lifecycled, not a truth
// about the target composer — when txd's own observation already proved the
// composer interactive, refusing the delivery on gate transport is a
// preflight false negative. The unpainted newborn keeps its hard stop: there
// the dead-zone race is real and txd has no interactivity proof of its own.

test('a gate transport failure with an observed-interactive composer attempts delivery and attests the unarmed gap', async () => {
  const { CommGateTransportFailure } = await import('../src/core.ts');
  const physical = {
    machine: 'test',
    configuration: { generation: 'g', digest: 'd' },
    agentWrapper: '/wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async () => undefined,
  };
  const { store, tmux, d } = await fixture(async () => {
    throw new CommGateTransportFailure('lifecycled_comm_gate_transport_ceiling_exceeded');
  }, physical);
  tmux.setPaneText('palace:W', '› Write tests for @filename\n\n  gpt-5.6-sol medium');

  const accepted = await d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'attempted first', ask: false, reply: false });

  expect(tmux.sends('palace:W').length).toBe(1); // the bytes were attempted
  // …and nothing is claimed that was not observed: no hook fact arrived, so
  // the delivery remains unasserted.
  expect((await d.commDelivery(accepted.message_id)).complete).toBe(false);
  expect((await store.readAll()).filter((e) => e.event_type === 'act.comm_delivery_asserted')).toHaveLength(0);
  const unarmed = (await store.readAll()).filter((e) => e.event_type === 'act.comm_watch_unarmed');
  expect(unarmed.length).toBe(1);
  expect(unarmed[0]!.payload.target_agent_id).toBe('worker');
});

test('a gate transport failure on an unpainted newborn still refuses before bytes', async () => {
  const { CommGateTransportFailure } = await import('../src/core.ts');
  const { store, tmux, d } = await fixture(async () => {
    throw new CommGateTransportFailure('lifecycled_comm_gate_transport_failed');
  });

  await expect(d.comm({ schema_version: SCHEMA_VERSION, source_agent_id: 'sender', target: 'worker', message: 'must not reach a newborn', ask: false, reply: false }))
    .rejects.toThrow('lifecycled_comm_gate_transport_failed');

  expect(tmux.sends('palace:W')).toEqual([]);
  const unarmed = (await store.readAll()).filter((e) => e.event_type === 'act.comm_watch_unarmed');
  expect(unarmed.length).toBe(1);
});
