// Retirement publication (chapter-locks spec §4): at the point txd writes
// reg.retired it publishes `agent.retired` on the bus — the reactive leg of the
// retirement authority split. registrationd's lock projection frees a chapter
// on this event, so the payload must carry enough to terminalize the right
// agent row.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, AgentRetiredSchema, type PhysicalDeclaration } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { bindOverseerSource, closeRequest } from './close-fixture.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

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
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      if (options.failPublish && type === 'agent.retired') throw new Error('bus_publish_refused:503');
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

async function bindRegisteredAgent(tmux: FakeTmux, d: Daemon, seatId: string): Promise<PhysicalDeclaration> {
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
  // Retirement is a post-birth concept: only a REGISTERED agent's close
  // publishes agent.retired, so the fixture completes the birth.
  await d.activateRegisteredAgent({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    registered_at: '2026-08-01T12:00:00.000Z',
    engine: 'claude',
    launch: { argv: [], requested_cwd: '/manual/work' },
    placement: {
      pane_id: seatId,
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
  return declaration;
}

function retirements(published: Array<{ type: string; payload: Record<string, unknown> }>) {
  return published.filter((event) => event.type === 'agent.retired');
}

test('close publishes agent.retired with the drafted contract shape', async () => {
  const { store, tmux, published, d } = setup();
  const declaration = await bindRegisteredAgent(tmux, d, 'palace:W');

  await bindOverseerSource(d, store);
  const res = await d.close(closeRequest([AGENT_ID]));
  expect(res).toMatchObject({ ok: true, closed_count: 1 });

  const retired = retirements(published);
  expect(retired).toHaveLength(1);
  const payload = AgentRetiredSchema.parse(retired[0]!.payload);
  expect(payload).toMatchObject({
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    seat_id: 'palace:W',
    pane_generation: declaration.pane_generation,
    machine: 'k12-personal',
    cause: 'close',
  });
});

test('a forced pane reset over a bound seat publishes agent.retired with cause estate_reset', async () => {
  const { tmux, published, d } = setup();
  await bindRegisteredAgent(tmux, d, 'palace:N');

  const res = await d.resetEstateScope({ schema_version: 12, force: true, scope: 'pane', pane: 'palace:N' });
  expect(res.ok).toBe(true);

  const retired = retirements(published);
  expect(retired).toHaveLength(1);
  expect(AgentRetiredSchema.parse(retired[0]!.payload)).toMatchObject({
    agent_id: AGENT_ID,
    seat_id: 'palace:N',
    cause: 'estate_reset',
  });
});

test('a clean stand-down then a pane reset never double-publishes', async () => {
  const { store, tmux, published, d } = setup();
  await bindRegisteredAgent(tmux, d, 'palace:E');

  await bindOverseerSource(d, store);
  expect((await d.close(closeRequest([AGENT_ID]))).ok).toBe(true);
  expect((await d.resetEstateScope({ schema_version: 12, force: true, scope: 'pane', pane: 'palace:E' })).ok).toBe(true);

  expect(retirements(published)).toHaveLength(1);
});

test('a failed reap publishes nothing — retire-with-live-process stays unspellable', async () => {
  const { store, tmux, published, d } = setup();
  await bindRegisteredAgent(tmux, d, 'palace:S');
  tmux.failReapSeat('palace:S');

  await bindOverseerSource(d, store);
  const res = await d.close(closeRequest([AGENT_ID]));
  expect(res).toMatchObject({ ok: false, refused_count: 1 });
  expect(retirements(published)).toHaveLength(0);
});

test('a bus refusal does not fail the close — the reap and event truth stand', async () => {
  const { store, tmux, d } = setup({ failPublish: true });
  await bindRegisteredAgent(tmux, d, 'palace:W');

  await bindOverseerSource(d, store);
  const res = await d.close(closeRequest([AGENT_ID]));
  expect(res).toMatchObject({ ok: true, closed_count: 1 });
  expect((await store.readAll()).map((e) => e.event_type)).toContain('reg.retired');
});

test('an unregistered daemon (no bus runtime) closes without publishing', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await d.launch({ seat_id: 'palace:W', schema_version: 12, identity: 'i1', persona: 'salamander', tint: '#302800' });

  await bindOverseerSource(d, store);
  const res = await d.close(closeRequest(['palace:W']));
  expect(res).toMatchObject({ ok: true, closed_count: 1 });
});

test('a non-registration launch identity is skipped, not published malformed', async () => {
  const { store, published, d } = setup();
  await d.launch({ seat_id: 'palace:W', schema_version: 12, identity: 'i1', persona: 'salamander', tint: '#302800' });

  await bindOverseerSource(d, store);
  const res = await d.close(closeRequest(['palace:W']));
  expect(res).toMatchObject({ ok: true, closed_count: 1 });
  expect(retirements(published)).toHaveLength(0);
});
