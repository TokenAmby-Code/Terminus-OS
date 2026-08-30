// The close-of-unregistered signal (chapter-locks lock-leak ruling): a binding
// whose agent never registered dies by registration abort, and registrationd
// can only abort on evidence. When a bound-but-unregistered seat closes — its
// pane died, its seat was reset, or an overseer closed it — txd publishes
// `agent.unregistered_closed` so registrationd aborts the birth and the
// chapter lock frees. Post-birth closes publish `agent.retired`, never this
// signal, and a binding carrying no birth generation identifies no birth, so
// it publishes nothing.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { AGENT_SCHEMA_VERSION } from '@tokenamby-code/agent-contract/agent';
import { UnregisteredClosedSchema, type PhysicalDeclaration } from '@tokenamby-code/agent-contract/events';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { bindOverseerSource, closeRequest } from './close-fixture.ts';
import type { TxdPublishedEventType } from '../src/events.ts';
import { AGENT_TICKET_ID } from './agent-fixture.ts';

const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };

function setup(options: { failPublish?: boolean } = {}) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      if (options.failPublish && type === 'agent.unregistered_closed') {
        throw new Error('bus_publish_refused:503');
      }
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

async function bindUnregistered(tmux: FakeTmux, d: Daemon, seatId: string): Promise<PhysicalDeclaration> {
  await tmux.createSeat(seatId);
  tmux.bindWrapper(4101, seatId);
  const declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: seatId,
    pane_generation: (await tmux.seatGeneration(seatId))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4101,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
  await d.recordPhysicalDeclaration(declaration);
  return declaration;
}

const ofType = (published: Array<{ type: string; payload: Record<string, unknown> }>, type: string) =>
  published.filter((event) => event.type === type);

// The schema-8 ruling: this event travels with the current Agent vocabulary,
// so it must never publish under literal 7 — literal 7 is spent. The pin goes
// red on any base whose contract still carries the pre-window version, which
// is exactly the merge ordering the ruling demands.
test('the contract literal rides schema 8, never 7', () => {
  expect(AGENT_SCHEMA_VERSION).toBe(8);
});

test('a bound-but-unregistered seat\'s pane death publishes agent.unregistered_closed and no agent.retired', async () => {
  const { tmux, published, d } = setup();
  for (const seat of ['palace:W', 'palace:N', 'palace:S', 'palace:E']) await tmux.createSeat(seat);
  const declaration = await bindUnregistered(tmux, d, 'palace:W');

  await tmux.killSeat('palace:W');
  const result = await d.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'palace' });
  expect(result.ok).toBe(true);
  expect(result.reset_seats).toEqual(['palace:W']);

  const signals = ofType(published, 'agent.unregistered_closed');
  expect(signals).toHaveLength(1);
  const payload = UnregisteredClosedSchema.parse(signals[0]!.payload);
  expect(payload).toMatchObject({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    seat_id: 'palace:W',
    pane_generation: declaration.pane_generation,
    machine: 'k12-personal',
    cause: 'estate_reset',
  });
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});

test('an overseer close of a never-registered binding publishes the signal with cause close', async () => {
  const { store, tmux, published, d } = setup();
  await bindUnregistered(tmux, d, 'palace:W');
  await bindOverseerSource(d, store);

  const result = await d.close(closeRequest(['palace:W']));
  expect(result).toMatchObject({ ok: true });

  const signals = ofType(published, 'agent.unregistered_closed');
  expect(signals).toHaveLength(1);
  expect(UnregisteredClosedSchema.parse(signals[0]!.payload)).toMatchObject({
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    seat_id: 'palace:W',
    cause: 'close',
  });
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});

test('a registered agent\'s close publishes agent.retired and never the unregistered signal', async () => {
  const { store, tmux, published, d } = setup();
  const declaration = await bindUnregistered(tmux, d, 'palace:W');
  await d.activateRegisteredAgent({
    schema_version: AGENT_SCHEMA_VERSION,
    ticket_id: AGENT_TICKET_ID,
    identity: `astartes:black-shields:${AGENT_ID}`,
    incarnation: { agent_id: AGENT_ID, birth_generation: BIRTH_GENERATION },
    registered_at: '2026-08-01T12:00:00.000Z',
    engine: 'claude',
    launch: { argv: [], requested_cwd: '/manual/work' },
    placement: {
      pane_id: 'palace:W',
      pane_generation: declaration.pane_generation,
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: 4101,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: {
      persona: 'black-shields',
      rank: 'astartes',
      commander: 'council:custodes',
      tint: '#111111',
      // A Black Shield is silent: no chapter, no voice.
      voice: null,
      continuity_references: [],
      instruction_package: {
        digest: 'c'.repeat(64),
        sources: [],
        cache_path: '/personas/black-shields/CLAUDE.md',
      },
    },
    resources: [],
  });

  await bindOverseerSource(d, store);
  expect(await d.close(closeRequest([AGENT_ID]))).toMatchObject({ ok: true, closed_count: 1 });
  expect(ofType(published, 'agent.retired')).toHaveLength(1);
  expect(ofType(published, 'agent.unregistered_closed')).toHaveLength(0);
});

test('a binding carrying no birth generation closes silently: no signal, no retirement', async () => {
  const { tmux, published, d } = setup();
  // The launch door binds an identity with no birth generation and no
  // registration — there is no birth for registrationd to abort, so the close
  // identifies nothing to signal.
  for (const seat of ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator']) {
    await tmux.createSeat(seat);
  }
  const launched = await d.launch({
    seat_id: 'council:custodes',
    schema_version: SCHEMA_VERSION,
    identity: 'birthless-launch-door-identity',
    persona: 'custodes',
    rank: 'overseer',
    tint: '#5f00d7',
  });
  expect(launched.ok).toBe(true);
  await tmux.killSeat('council:custodes');
  const result = await d.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'council' });
  expect(result.ok).toBe(true);
  expect(result.reset_seats).toEqual(['council:custodes']);
  expect(ofType(published, 'agent.unregistered_closed')).toHaveLength(0);
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});

test('a publish refusal is an insurance gap, never an un-close: the seat still frees', async () => {
  const { store, tmux, d } = setup({ failPublish: true });
  await bindUnregistered(tmux, d, 'palace:W');
  await bindOverseerSource(d, store);
  const result = await d.close(closeRequest(['palace:W']));
  expect(result).toMatchObject({ ok: true });
  // The store facts committed before the publish, so the seat is free: a
  // second close refuses on no_binding, the unbound truth.
  expect(await d.close(closeRequest(['palace:W']))).toMatchObject({ ok: false });
});

test('replaying the abort txd receives back finds nothing standing and changes nothing', async () => {
  const { store, tmux, published, d } = setup();
  await bindUnregistered(tmux, d, 'palace:W');
  await bindOverseerSource(d, store);
  expect(await d.close(closeRequest(['palace:W']))).toMatchObject({ ok: true });
  const afterClose = published.length;
  // registrationd's abort arrives after txd already cleared the binding — the
  // convergent no-op leg of the loop this signal opens.
  await d.abortRegistration({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    pane_generation: null,
    persona: 'black-shields',
    reason: 'unregistered_closed',
    aborted_at: '2026-08-01T12:00:00.000Z',
  }, 'bus:11');
  expect(published.length).toBe(afterClose);
});
