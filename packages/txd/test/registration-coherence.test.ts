// Level-two coherence and seat resolution.
//
// registrationd asserts "this agent id will be this persona"; txd checks that
// assertion against the estate tmux actually attests, then signs off. It reads
// the observed seat, never the pane the declaration claims, because the claim
// is the thing under audit.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION } from '@tokenamby-code/agent-contract/agent';
import { type PhysicalDeclaration } from '@tokenamby-code/agent-contract/events';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { buildProjections } from '../src/projections.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };

function setup() {
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
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

async function declare(
  tmux: FakeTmux,
  seatId: string,
  persona: string | null,
  rank: string | null,
  tint: string | null,
): Promise<PhysicalDeclaration> {
  await tmux.createSeat(seatId);
  const paneGeneration = (await tmux.seatGeneration(seatId))!;
  tmux.bindWrapper(4101, seatId);
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: seatId,
    pane_generation: paneGeneration,
    configuration: CONFIGURATION,
    engine: 'claude' as const,
    wrapper_pid: 4101,
    persona,
    rank,
    tint,
  };
}

test('a council persona is refused in a worker seat', async () => {
  const { tmux, d } = setup();
  const declaration = await declare(tmux, 'palace:W', 'custodes', 'overseer', '#302800');
  await expect(d.recordPhysicalDeclaration(declaration)).rejects.toThrow('persona_seat_incoherent');
});

test('a council persona is refused in another council seat', async () => {
  const { tmux, d } = setup();
  const declaration = await declare(tmux, 'council:fabricator-general', 'custodes', 'overseer', '#302800');
  await expect(d.recordPhysicalDeclaration(declaration)).rejects.toThrow('persona_seat_incoherent');
});

test('a council persona is admitted in its own seat', async () => {
  const { store, tmux, d } = setup();
  const declaration = await declare(tmux, 'council:custodes', 'custodes', 'overseer', '#302800');
  await d.recordPhysicalDeclaration(declaration);
  expect(buildProjections(await store.readAll()).physicalDeclarations.get(AGENT_ID))
    .toMatchObject({ pane_id: 'council:custodes', persona: 'custodes' });
});

test('a Black Shield is admitted in a worker seat and binds under its own persona', async () => {
  const { store, tmux, d } = setup();
  const declaration = await declare(tmux, 'palace:W', 'black-shields', 'astartes', '#111111');
  await d.recordPhysicalDeclaration(declaration);
  const binding = buildProjections(await store.readAll())
    .currentBindings.find((candidate) => candidate.agent_id === AGENT_ID)!;
  expect(binding).toMatchObject({
    seat_id: 'palace:W',
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  });
  expect(await tmux.seatTint('palace:W')).toBe('#111111');
});

test('Black Shields take no lock — a second one binds a second worker seat', async () => {
  const { store, tmux, d } = setup();
  await d.recordPhysicalDeclaration(await declare(tmux, 'palace:W', 'black-shields', 'astartes', '#111111'));

  const second = '7b1a6c22-3b0e-4a52-9d1f-2c8e5f4a1b93';
  await tmux.createSeat('palace:N');
  tmux.bindWrapper(4102, 'palace:N');
  const secondDeclaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: second,
    birth_generation: '5a3c9d18-7b21-4f3e-8c0a-1d2e3f405162',
    pane_id: 'palace:N',
    pane_generation: (await tmux.seatGeneration('palace:N'))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4102,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
  await d.recordPhysicalDeclaration(secondDeclaration);
  const shields = buildProjections(await store.readAll())
    .currentBindings.filter((binding) => binding.persona === 'black-shields');
  expect(shields.map((binding) => binding.seat_id).sort()).toEqual(['palace:N', 'palace:W']);
});
