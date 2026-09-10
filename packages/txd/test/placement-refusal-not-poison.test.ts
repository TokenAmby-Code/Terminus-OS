// Behavioral pin: a Door-1 placement refusal is a terminal receipt, not a
// poisoned journal event. The wire contract remains agent-contract 1.2.0;
// the lower-level wrapper observation stays on txd's typed internal error.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, type Agent } from '@tokenamby-code/agent-contract/agent';
import type { PhysicalDeclaration } from '@tokenamby-code/agent-contract/events';
import { createTxdEventLane, type TxdJournalEvent } from '../src/event-journal.ts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { AGENT_TICKET_ID } from './agent-fixture.ts';

const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const PANE_GENERATION = 'a6b186fe-6b1e-4b51-830a-b975a82ceef8';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };
const OCCURRED_AT = new Date('2026-09-09T20:41:59.419-07:00');

function declaration(): PhysicalDeclaration {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: 'mechanicus:a08c3cd0-b9de-4507-a51d-5d9ea0f926a5',
    pane_generation: PANE_GENERATION,
    configuration: CONFIGURATION,
    engine: 'codex',
    wrapper_pid: 1_543_700,
    persona: 'death-guard',
    rank: 'astartes',
    tint: '#6b7f3a',
  };
}

function journalEvent(eventType: string, payload: Record<string, unknown>): TxdJournalEvent {
  return {
    seq: 26_679,
    event_id: '11111111-1111-4111-8111-111111111111',
    event_type: eventType,
    schema_version: 1,
    producer: 'registrationd',
    producer_role: 'registrationd',
    estate: 'k12-personal',
    placement: 'k12-personal',
    occurred_at: OCCURRED_AT,
    recorded_at: OCCURRED_AT,
    payload,
    provenance: {},
    stream_id: null,
    stream_seq: null,
    causation_event_id: null,
    correlation_id: null,
  };
}

function absentWrapperSetup() {
  const tmux = new FakeTmux();
  tmux.attestWrapperPlacement = async () => ({ ok: false, reason: 'wrapper_process_missing' });
  const publications = new Map<string, Record<string, unknown>>();
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: string, payload: Record<string, unknown>) => {
      const key = `${type}:${String(payload.birth_generation)}`;
      const existing = publications.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(payload)) {
        throw new Error('idempotency_conflict');
      }
      publications.set(key, structuredClone(payload));
    },
  };
  const daemon = new Daemon(new MemoryEventStore(), tmux, undefined, undefined, runtime as never);
  return { daemon, publications };
}

test('absent wrapper is one handled placement refusal, never journal poison, and replay is idempotent', async () => {
  const { daemon, publications } = absentWrapperSetup();
  const lane = createTxdEventLane({ machine: 'k12-personal', daemon });
  const event = journalEvent('agent.physical_declared', declaration() as unknown as Record<string, unknown>);

  await expect(lane.handle(null as never, event)).resolves.toBeUndefined();
  await expect(lane.handle(null as never, event)).resolves.toBeUndefined();

  expect([...publications.entries()]).toEqual([[
    `agent.placement_refused:${BIRTH_GENERATION}`,
    {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: AGENT_ID,
      birth_generation: BIRTH_GENERATION,
      pane_id: declaration().pane_id,
      pane_generation: PANE_GENERATION,
      machine: 'k12-personal',
      reason: 'physical_declaration_contradicted',
      refused_at: OCCURRED_AT.toISOString(),
    },
  ]]);
});

test('the typed internal refusal retains wrapper_process_missing without changing the wire payload', async () => {
  const { daemon, publications } = absentWrapperSetup();

  try {
    await daemon.recordPhysicalDeclaration(declaration(), 'bus:26679');
    throw new Error('expected placement refusal');
  } catch (error) {
    expect(error).toMatchObject({
      name: 'PlacementRefusalError',
      message: 'physical_declaration_contradicted',
      observation_reason: 'wrapper_process_missing',
    });
  }
  expect([...publications.values()]).toHaveLength(1);
  expect([...publications.values()][0]).not.toHaveProperty('detail');
});

function registeredAgent(): Agent {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    ticket_id: AGENT_TICKET_ID,
    identity: `astartes:death-guard:${AGENT_ID}`,
    incarnation: { agent_id: AGENT_ID, birth_generation: BIRTH_GENERATION },
    registered_at: OCCURRED_AT.toISOString(),
    engine: 'codex',
    launch: { argv: [], requested_cwd: '/worktree' },
    placement: {
      pane_id: declaration().pane_id,
      pane_generation: PANE_GENERATION,
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: 1_543_700,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: {
      persona: 'death-guard',
      rank: 'astartes',
      commander: 'council:fabricator-general',
      tint: '#6b7f3a',
      voice: null,
      continuity_references: [],
      instruction_package: {
        digest: 'd'.repeat(64),
        sources: [],
        cache_path: '/personas/death-guard/CODEX.md',
      },
    },
    resources: [],
  };
}

test('registered_agent_physical_conflict remains a poison-only negative control', async () => {
  const { daemon } = absentWrapperSetup();
  const lane = createTxdEventLane({ machine: 'k12-personal', daemon });
  const event = journalEvent('agent.registered', registeredAgent() as unknown as Record<string, unknown>);

  await expect(lane.handle(null as never, event)).rejects.toMatchObject({
    name: 'PoisonEventError',
    code: 'registered_agent_physical_conflict',
  });
});
