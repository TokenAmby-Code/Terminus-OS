// Adversarial lane: txd audits the persona it is told; it never transcribes it.
// A binding that copies whatever registrationd sent, and a `reg.bound` written
// with a blank persona to be filled in later, both stay dead.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, type Agent, type PhysicalDeclaration } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (_type: TxdPublishedEventType, _payload: Record<string, unknown>) => {},
  };
  return { store, tmux, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

test('adversarial: a persona asserted into a seat that cannot hold it never reaches the event stream', async () => {
  const { store, tmux, d } = setup();
  await tmux.createSeat('palace:W');
  tmux.bindWrapper(4101, 'palace:W');
  const declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    pane_generation: (await tmux.seatGeneration('palace:W'))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4101,
    persona: 'fabricator-general',
    rank: 'overseer',
    tint: '#300808',
  };
  await expect(d.recordPhysicalDeclaration(declaration)).rejects.toThrow('persona_seat_incoherent');
  expect(await store.readAll()).toEqual([]);
});

test('adversarial: a bound seat never carries a blank persona waiting to be filled', async () => {
  const { store, tmux, d } = setup();
  await tmux.createSeat('palace:W');
  tmux.bindWrapper(4101, 'palace:W');
  const bound_declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    pane_generation: (await tmux.seatGeneration('palace:W'))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4101,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
  await d.recordPhysicalDeclaration(bound_declaration);
  const bound = (await store.readAll()).find((event) => event.event_type === 'reg.bound')!;
  expect(bound.payload.persona).toBe('black-shields');
  expect(bound.payload.rank).toBe('astartes');
});

test('adversarial: an ambiguous identity is never resolved by picking one', async () => {
  const { store, tmux, d } = setup();
  await tmux.createSeat('palace:W');
  await tmux.createSeat('palace:N');
  const bind = async (seatId: string, agentId: string, wrapperPid: number) => {
    tmux.bindWrapper(wrapperPid, seatId);
    const seatDeclaration: PhysicalDeclaration = {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: agentId,
      birth_generation: crypto.randomUUID(),
      pane_id: seatId,
      pane_generation: (await tmux.seatGeneration(seatId))!,
      configuration: CONFIGURATION,
      engine: 'claude',
      wrapper_pid: wrapperPid,
      persona: 'black-shields',
      rank: 'astartes',
      tint: '#111111',
    };
    await d.recordPhysicalDeclaration(seatDeclaration);
    const agent: Agent = {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: agentId,
      birth_generation: (await store.readAll())
        .find((event) => event.event_type === 'reg.bound' && event.entity_id === seatId)!
        .payload.birth_generation as string,
      registered_at: '2026-07-31T00:00:00.000Z',
      engine: 'claude',
      launch: { argv: [], requested_cwd: '/workspace' },
      placement: {
        pane_id: seatId,
        pane_generation: (await tmux.seatGeneration(seatId))!,
        machine: 'k12-personal',
        kind: 'local',
        wrapper_pid: wrapperPid,
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
        instruction_package: {
          digest: 'd'.repeat(64),
          sources: [],
          cache_path: '/personas/black-shields/CLAUDE.md',
        },
      },
      resources: [],
    };
    await d.activateRegisteredAgent(agent);
  };
  const first = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
  const second = '7b1a6c22-3b0e-4a52-9d1f-2c8e5f4a1b93';
  await bind('palace:W', first, 4101);
  await bind('palace:N', second, 4102);

  await expect(d.transitionMode({
    schema_version: 11,
    target: 'black-shields',
    intent: 'enter_plan',
    trigger: 'preplan',
  })).rejects.toThrow('address one agent by AGENT_ID or seat id');
});
