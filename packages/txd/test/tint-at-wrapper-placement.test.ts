// Tint, binding, and placement attestation happen at wrapper placement.
//
// `agent.physical_declared` is the moment the wrapper is attested into its
// seat and the persona assertion (including tint) is in hand — so it is the
// moment txd binds the seat, paints it, and publishes
// `agent.placement_attested`. No engine process is consulted: a codex engine
// that has not taken its first turn is still a placed, tinted, registered
// agent.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, AgentSchema, PlacementAttestedSchema, type PhysicalDeclaration } from '@terminus-os/contracts';
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
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

// A declaration for a wrapper that has NOT spawned an engine process yet —
// the codex-before-first-turn shape. bindEngine is deliberately absent.
async function declareWrapperOnly(
  tmux: FakeTmux,
  seatId: string,
  tint: string | null = '#111111',
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
    engine: 'codex' as const,
    wrapper_pid: 4101,
    persona: 'black-shields',
    rank: 'astartes',
    tint,
  };
}

test('a declaration alone binds the seat, applies the tint, and attests placement', async () => {
  const { store, tmux, published, d } = setup();
  const declaration = await declareWrapperOnly(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(declaration);

  expect(await tmux.seatTint('palace:W')).toBe('#111111');

  const events = await store.readAll();
  const types = events.map((event) => event.event_type);
  expect(types).toContain('reg.bound');
  expect(types).toContain('reg.placement_attested');

  const binding = buildProjections(events).currentBindings
    .find((candidate) => candidate.agent_id === AGENT_ID);
  expect(binding).toMatchObject({ seat_id: 'palace:W', tint: '#111111' });

  const placement = published.find((event) => event.type === 'agent.placement_attested');
  expect(placement).toBeDefined();
  expect(PlacementAttestedSchema.parse(placement!.payload)).toMatchObject({
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    wrapper_pid: 4101,
  });
});

test('a redelivered declaration is idempotent — one binding, one placement', async () => {
  const { store, tmux, published, d } = setup();
  const declaration = await declareWrapperOnly(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(declaration);
  await d.recordPhysicalDeclaration(declaration);

  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.bound')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'reg.placement_attested')).toHaveLength(1);
  expect(published.filter((event) => event.type === 'agent.placement_attested')).toHaveLength(1);
});

test('a tint the estate cannot attest aborts the binding', async () => {
  const { store, tmux, d } = setup();
  const declaration = await declareWrapperOnly(tmux, 'palace:W');
  tmux.failTintSeat('palace:W');
  await expect(d.recordPhysicalDeclaration(declaration)).rejects.toThrow('tint_attestation_failed');
  const projections = buildProjections(await store.readAll());
  expect(projections.currentBindings.find((candidate) => candidate.agent_id === AGENT_ID))
    .toBeUndefined();
});

test('a null tint binds dark', async () => {
  const { store, tmux, published, d } = setup();
  const declaration = await declareWrapperOnly(tmux, 'palace:W', null);
  await d.recordPhysicalDeclaration(declaration);
  expect((await tmux.seatTint('palace:W')) ?? null).toBeNull();
  expect(buildProjections(await store.readAll()).currentBindings
    .find((candidate) => candidate.agent_id === AGENT_ID))
    .toMatchObject({ tint: null });
  expect(published.some((event) => event.type === 'agent.placement_attested')).toBe(true);
});

test('placement and agent contracts attest the wrapper, not an engine process', () => {
  const placement = PlacementAttestedSchema.safeParse({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    pane_generation: '3b9ac9b1-64c9-4c69-9c5a-3f4d0a1b2c3d',
    configuration: CONFIGURATION,
    machine: 'k12-personal',
    kind: 'local',
    wrapper_pid: 4101,
    transport_witnesses: {},
  });
  expect(placement.success).toBe(true);

  const agent = AgentSchema.safeParse({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    registered_at: '2026-07-31T00:00:00.000Z',
    engine: 'codex',
    launch: {
      argv: ['codex'],
      requested_cwd: '/workspace',
    },
    placement: {
      pane_id: 'palace:W',
      pane_generation: '3b9ac9b1-64c9-4c69-9c5a-3f4d0a1b2c3d',
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: 4101,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: null,
    resources: [],
  });
  expect(agent.success).toBe(true);
});

test('a registered agent activates against a wrapper-placement binding', async () => {
  const { tmux, d, store } = setup();
  const declaration = await declareWrapperOnly(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(declaration);
  await d.activateRegisteredAgent(AgentSchema.parse({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    registered_at: '2026-07-31T00:00:00.000Z',
    engine: 'codex',
    launch: { argv: ['codex'], requested_cwd: '/workspace' },
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
      commander: null,
      tint: '#111111',
      voice: null,
      continuity_references: [],
      instruction_package: { digest: 'd'.repeat(64), sources: [], cache_path: '/workspace/CLAUDE.md' },
    },
    resources: [],
  }));
  const binding = buildProjections(await store.readAll()).currentBindings
    .find((candidate) => candidate.agent_id === AGENT_ID);
  expect(binding?.registered).toBe(true);
});
