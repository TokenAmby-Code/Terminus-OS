// The boot-time occupancy census: the symmetric partner of the vacancy sweep.
// The sweep says which declared seats the estate wants filled; the census says
// who is seated. Both are assertions txd makes at boot fold completion from
// truth it already holds, once — no timer, no repeating sweep.
//
// The census exists because `agent.retired` is published after the close is
// already committed and a dropped publication is never revisited: a consumer
// left believing a departed agent still holds its seat will never hear
// otherwise, because no further event about that agent is coming. Only the
// estate can say who is actually seated, and only a COMPLETE roster reaches an
// agent whose seat belonged to an estate generation that no longer exists.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { AGENT_SCHEMA_VERSION } from '@tokenamby-code/agent-contract/agent';
import { EstateOccupancyCensusSchema, type EstateOccupancyCensus, type PhysicalDeclaration } from '@tokenamby-code/agent-contract/events';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { bindOverseerSource, closeRequest, retirementClear } from './close-fixture.ts';
import type { TxdPublishedEventType } from '../src/events.ts';
import { AGENT_TICKET_ID } from './agent-fixture.ts';

const AGENT_ID = '708f52b6-5d8d-49cb-abab-caa3312244f9';
const BIRTH_GENERATION = 'd78bdf2f-661b-471f-a561-a25c2230a0b7';
const OTHER_AGENT_ID = '3f0c1a94-6d2b-4f7a-8e51-9c4b2d6a7f13';
const OTHER_BIRTH_GENERATION = 'c6dd56ca-1f0a-4f2c-9c22-8b7f4a91a2c4';
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
      if (options.failPublish && type === 'agent.estate_occupancy_census') {
        throw new Error('bus_publish_refused:503');
      }
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime, null, null, null, undefined, retirementClear) };
}

const censuses = (published: Array<{ type: string; payload: Record<string, unknown> }>): EstateOccupancyCensus[] =>
  published
    .filter((event) => event.type === 'agent.estate_occupancy_census')
    .map((event) => EstateOccupancyCensusSchema.parse(event.payload));

async function seatRegisteredAgent(
  tmux: FakeTmux,
  d: Daemon,
  seatId: string,
  agentId: string = AGENT_ID,
  birthGeneration: string = BIRTH_GENERATION,
): Promise<PhysicalDeclaration> {
  const wrapperPid = 4100 + seatId.length;
  tmux.bindWrapper(wrapperPid, seatId);
  const declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: agentId,
    birth_generation: birthGeneration,
    pane_id: seatId,
    pane_generation: (await tmux.seatGeneration(seatId))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: wrapperPid,
    persona: 'sons-of-horus',
    rank: 'astartes',
    tint: '#1b3a2f',
  };
  await d.recordPhysicalDeclaration(declaration);
  await d.activateRegisteredAgent({
    schema_version: AGENT_SCHEMA_VERSION,
    ticket_id: AGENT_TICKET_ID,
    identity: `astartes:sons-of-horus:${agentId}`,
    incarnation: { agent_id: agentId, birth_generation: birthGeneration },
    registered_at: '2026-08-14T12:00:00.000Z',
    engine: 'claude',
    launch: { argv: [], requested_cwd: '/manual/work' },
    placement: {
      pane_id: seatId,
      pane_generation: declaration.pane_generation,
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: wrapperPid,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: {
      persona: 'sons-of-horus',
      rank: 'astartes',
      commander: 'council:custodes',
      tint: '#1b3a2f',
      voice: null,
      continuity_references: [],
      instruction_package: {
        digest: 'c'.repeat(64),
        sources: [],
        cache_path: '/personas/sons-of-horus/CLAUDE.md',
      },
    },
    resources: [],
  });
  return declaration;
}

test('boot asserts exactly one census, and an estate holding nobody says so', async () => {
  const { published, d } = setup();

  await d.constructEstate();

  const asserted = censuses(published);
  expect(asserted).toHaveLength(1);
  expect(asserted[0]).toMatchObject({
    schema_version: AGENT_SCHEMA_VERSION,
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    occupied: [],
  });
  // The instant the fold observed: what makes an absence readable at all.
  expect(Date.parse(asserted[0]!.taken_at)).not.toBeNaN();
});

test('a seated agent is asserted with the seat it sits in', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  const declaration = await seatRegisteredAgent(tmux, d, 'somnium:N');
  published.length = 0;

  await d.constructEstate();

  expect(censuses(published)[0]!.occupied).toEqual([{
    seat_id: 'somnium:N',
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_generation: declaration.pane_generation,
    registered: true,
  }]);
});

test('an agent that left is absent from the roster — the departure a lost publication swallowed', async () => {
  const { store, tmux, published, d } = setup();
  await d.constructEstate();
  await seatRegisteredAgent(tmux, d, 'somnium:N');
  await seatRegisteredAgent(tmux, d, 'palace:W', OTHER_AGENT_ID, OTHER_BIRTH_GENERATION);
  await bindOverseerSource(d, store);
  expect((await d.close(closeRequest([AGENT_ID]))).ok).toBe(true);
  published.length = 0;

  await d.constructEstate();

  // Complete over the machine: the survivor is named, the departed is not, and
  // that absence is the only thing a consumer will ever be told about it.
  const seated = censuses(published)[0]!.occupied.map((occupant) => occupant.agent_id);
  expect(seated).toContain(OTHER_AGENT_ID);
  expect(seated).not.toContain(AGENT_ID);
});

test('a bound-but-unregistered seat is occupied — an incomplete birth still sits there', async () => {
  const { published, d } = setup();
  await d.constructEstate();
  const launched = await d.launch({
    seat_id: 'palace:W',
    schema_version: SCHEMA_VERSION,
    identity: OTHER_AGENT_ID,
    persona: 'salamander',
    tint: '#302800',
  });
  expect(launched.ok).toBe(true);
  published.length = 0;

  await d.constructEstate();

  expect(censuses(published)[0]!.occupied).toEqual([{
    seat_id: 'palace:W',
    agent_id: OTHER_AGENT_ID,
    birth_generation: null,
    pane_generation: expect.any(String),
    registered: false,
  }]);
});

test('the census is a boot fold, not a sweep: nothing else asserts one', async () => {
  const { store, tmux, published, d } = setup();
  await d.constructEstate();
  await seatRegisteredAgent(tmux, d, 'somnium:N');
  published.length = 0;

  await d.announceVacantPerpetualSeats();
  await bindOverseerSource(d, store);
  expect((await d.close(closeRequest([AGENT_ID]))).ok).toBe(true);

  expect(censuses(published)).toHaveLength(0);
});

test('a census the bus refuses leaves the boot standing and the estate built', async () => {
  const { store, d } = setup({ failPublish: true });

  const built = await d.constructEstate();

  expect(built.failed).toEqual([]);
  expect((await store.readAll()).map((event) => event.event_type)).toContain('reg.pane_created');
});

test('a daemon with no journal runtime asserts nothing', async () => {
  const store = new MemoryEventStore();
  const d = new Daemon(store, new FakeTmux(), undefined, undefined, null, null, null, null, undefined, retirementClear);

  const built = await d.constructEstate();

  expect(built.failed).toEqual([]);
});
