// The registration-abort event, txd side (chapter-locks spec v2 §4):
// registrationd aborts its own partial birth transactions and txd consumes
// `agent.registration_aborted` to close and un-tint any binding still
// standing. An abort-path close is NOT a retirement — retirement is a
// post-birth concept, so `agent.retired` never publishes for a binding whose
// agent was never registered. Door 1 refusing a declared placement publishes
// `agent.placement_refused`, the evidence registrationd aborts on.

import { expect, test } from 'bun:test';
import {
  AGENT_SCHEMA_VERSION,
  PlacementRefusedSchema,
  type Agent,
  type PhysicalDeclaration,
  type RegistrationAborted,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { bindOverseerSource, closeRequest } from './close-fixture.ts';
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

async function declaration(tmux: FakeTmux, seatId: string): Promise<PhysicalDeclaration> {
  await tmux.createSeat(seatId);
  tmux.bindWrapper(4101, seatId);
  return {
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
}

function abortEvent(overrides: Partial<RegistrationAborted> = {}): RegistrationAborted {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    pane_generation: null,
    persona: 'black-shields',
    reason: 'wrapper_reply_expired',
    aborted_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function registeredAgent(decl: PhysicalDeclaration): Agent {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: decl.agent_id,
    birth_generation: decl.birth_generation,
    registered_at: '2026-08-01T12:00:00.000Z',
    engine: decl.engine,
    launch: { argv: [], requested_cwd: '/manual/work' },
    placement: {
      pane_id: decl.pane_id,
      pane_generation: decl.pane_generation,
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: decl.wrapper_pid,
      transport_witnesses: {},
    },
    configuration: decl.configuration,
    persona: {
      persona: 'black-shields',
      rank: 'astartes',
      commander: 'council:custodes',
      tint: '#111111',
      voice: null,
      workspace: '/personas/black-shields',
      continuity_references: [],
      instruction_package: {
        digest: 'c'.repeat(64),
        sources: [],
        rendered_path: '/personas/black-shields/CLAUDE.md',
      },
    },
    resources: [],
  };
}

const ofType = (published: Array<{ type: string; payload: Record<string, unknown> }>, type: string) =>
  published.filter((event) => event.type === type);

test('a door-1 audit refusal publishes agent.placement_refused with the audit reason', async () => {
  const { tmux, published, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  // Asserting a council persona into a worker seat is incoherent at Door 1.
  const incoherent = { ...decl, persona: 'custodes', rank: null, tint: '#c9a227' };
  await expect(d.recordPhysicalDeclaration(incoherent, 'bus:9')).rejects.toThrow('persona_seat_incoherent');
  const refusals = ofType(published, 'agent.placement_refused');
  expect(refusals).toHaveLength(1);
  const refusal = PlacementRefusedSchema.parse(refusals[0]!.payload);
  expect(refusal).toMatchObject({
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'palace:W',
    reason: 'persona_seat_incoherent',
  });
});

test('a tint attestation failure aborts the binding fail-dark and publishes placement_refused', async () => {
  const { tmux, published, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  tmux.failTintSeat('palace:W');
  await expect(d.recordPhysicalDeclaration(decl, 'bus:9')).rejects.toThrow('tint_attestation_failed');
  const refusals = ofType(published, 'agent.placement_refused');
  expect(refusals).toHaveLength(1);
  expect(PlacementRefusedSchema.parse(refusals[0]!.payload).reason).toBe('tint_attestation_failed');
  expect(ofType(published, 'agent.placement_attested')).toHaveLength(0);
});

test('consuming an abort closes the binding, un-tints the seat, and publishes NO agent.retired', async () => {
  const { tmux, store, published, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(decl, 'bus:9');
  expect(await tmux.seatTint('palace:W')).toBe('#111111');
  await bindOverseerSource(d, store);
  await d.abortRegistration(abortEvent(), 'bus:10');
  // The seat is free again: a close of the same target refuses loud on
  // no_binding, which is the unbound truth stated by the close door itself.
  expect(await d.close(closeRequest(['palace:W']))).toMatchObject({ ok: false });
  expect(await tmux.seatTint('palace:W')).toBeNull();
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});

test('an abort replay converges: the second delivery finds nothing standing and changes nothing', async () => {
  const { tmux, published, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(decl, 'bus:9');
  await d.abortRegistration(abortEvent(), 'bus:10');
  const eventsAfterFirst = published.length;
  await d.abortRegistration(abortEvent(), 'bus:11');
  expect(published.length).toBe(eventsAfterFirst);
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});

test('an abort for a registered agent refuses: post-birth cleanup is retirement, never abort', async () => {
  const { tmux, store, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(decl, 'bus:9');
  await d.activateRegisteredAgent(registeredAgent(decl));
  await expect(d.abortRegistration(abortEvent(), 'bus:10')).rejects.toThrow('abort_of_registered_agent');
  // The binding stands untouched: the registered agent still holds its tint
  // and a close of the same target still resolves the binding.
  expect(await tmux.seatTint('palace:W')).toBe('#111111');
  await bindOverseerSource(d, store);
  expect(await d.close(closeRequest([AGENT_ID]))).toMatchObject({ ok: true, closed_count: 1 });
});

test('closing a never-registered binding publishes no agent.retired — retirement is post-birth', async () => {
  const { tmux, store, published, d } = setup();
  const decl = await declaration(tmux, 'palace:W');
  await d.recordPhysicalDeclaration(decl, 'bus:9');
  await bindOverseerSource(d, store);
  const result = await d.close(closeRequest(['palace:W']));
  expect(result.ok).toBe(true);
  expect(ofType(published, 'agent.retired')).toHaveLength(0);
});
