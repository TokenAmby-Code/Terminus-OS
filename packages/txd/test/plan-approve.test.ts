// approve_plan — the mechanical plan-approval executor. txd drives the posed
// plan dialog and reads back the evidence; WHEN to approve is lifecycled's
// correlation, arriving here only as a deliberate /agents/mode request.
import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, SCHEMA_VERSION, type Agent, type PhysicalDeclaration } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux, RealTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };
const SEAT = 'palace:W';

async function launched() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (_type: TxdPublishedEventType, _payload: Record<string, unknown>) => {},
  };
  const d = new Daemon(store, tmux, undefined, undefined, runtime);
  await tmux.createSeat(SEAT);
  tmux.bindWrapper(4101, SEAT);
  const declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: SEAT,
    pane_generation: (await tmux.seatGeneration(SEAT))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4101,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
  await d.recordPhysicalDeclaration(declaration);
  const agent: Agent = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    registered_at: '2026-07-31T00:00:00.000Z',
    engine: 'claude',
    launch: { argv: [], requested_cwd: '/workspace' },
    placement: {
      pane_id: SEAT,
      pane_generation: (await tmux.seatGeneration(SEAT))!,
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
      instruction_package: {
        digest: 'd'.repeat(64),
        sources: [],
        cache_path: '/personas/black-shields/CLAUDE.md',
      },
    },
    resources: [],
  };
  await d.activateRegisteredAgent(agent);
  return { store, tmux, d };
}

test('approve_plan accepts a posed plan dialog and attests the transition', async () => {
  const { store, tmux, d } = await launched();
  tmux.setAgentMode(SEAT, 'plan');
  tmux.setPlanDialog(SEAT, true);
  const res = await d.transitionMode({
    schema_version: SCHEMA_VERSION,
    target: AGENT_ID,
    intent: 'approve_plan',
    trigger: 'preplan',
  });
  expect(res).toMatchObject({ ok: true, intent: 'approve_plan', verified: true, changed: true, mechanism: 'dialog_accept' });
  expect(tmux.planDialog(SEAT)).toBe(false);
  const types = (await store.readAll()).map((e) => e.event_type);
  expect(types).toContain('act.mode_transition_attested');
});

test('approve_plan with no posed dialog fails loud — nothing is typed blind', async () => {
  const { store, tmux, d } = await launched();
  tmux.setAgentMode(SEAT, 'plan');
  const res = await d.transitionMode({
    schema_version: SCHEMA_VERSION,
    target: AGENT_ID,
    intent: 'approve_plan',
    trigger: 'operator',
  });
  expect(res).toMatchObject({ ok: false, verified: false, mechanism: 'none' });
  expect(tmux.modeInputs(SEAT)).toEqual([]);
  const types = (await store.readAll()).map((e) => e.event_type);
  expect(types).toContain('act.mode_transition_failed');
});

test('detectPlanDialog recognizes the posed-plan prompt and nothing else', () => {
  expect(RealTmux.detectPlanDialog('│ Would you like to proceed? │\n│ ❯ 1. Yes, and auto-accept edits │', 'claude')).toBe(true);
  expect(RealTmux.detectPlanDialog('Ready to code?\n❯ 1. Yes, and auto-accept edits', 'claude')).toBe(true);
  expect(RealTmux.detectPlanDialog('plan mode on · thinking', 'claude')).toBe(false);
  expect(RealTmux.detectPlanDialog('$ bash prompt', 'claude')).toBe(false);
  // Codex has no vendor plan-approval dialog; the detector never claims one.
  expect(RealTmux.detectPlanDialog('Would you like to proceed?', 'codex')).toBe(false);
});
