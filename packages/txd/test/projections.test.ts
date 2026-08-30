import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { buildProjections } from '../src/projections.ts';
import type { EventInput, EventRecord } from '@terminus-os/contracts';

const prov = { source: 'wrapper' as const, transport_receipt: null, emitter_version: 1 };
function e(over: Partial<EventInput>): EventInput {
  return { entity_type: 'seat', entity_id: 'x', event_type: 'reg.pane_created', payload: {}, provenance: prov, occurred_at: 't', ...over } as EventInput;
}

test('a registered Agent birth ticket is projected read-only into estate and inspect rows', async () => {
  const s = new MemoryEventStore();
  const ticketId = '33333333-3333-4333-8333-333333333333';
  await s.append(e({ entity_id: 'palace:W', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_id: 'palace:W', event_type: 'reg.bound', payload: { agent_id: 'worker-1', birth_generation: 'birth-1' } }));
  await s.append(e({ entity_type: 'agent', entity_id: 'worker-1', event_type: 'reg.agent_registered', payload: { ticket_id: ticketId } }));

  const projection = buildProjections(await s.readAll());
  expect(projection.currentBindings[0]?.ticket_id).toBe(ticketId);
  expect(projection.seatBoard[0]?.ticket_id).toBe(ticketId);
  await s.close();
});

test('a txd checkpoint replays an immutable pre-v8 physical declaration without rewriting it', () => {
  const declaration = {
    schema_version: 6,
    agent_id: '2ea2d049-0106-4957-8649-31f93bdc8c9a',
    birth_generation: '1cc2112c-9c38-45a1-839f-831c33a1096a',
    pane_id: 'palace:W',
    pane_generation: '786b72b2-58d5-4294-8f95-928289984d6f',
    configuration: { generation: 'estate-1', digest: 'c'.repeat(64) },
    engine: 'codex', wrapper_pid: 4101, persona: 'black-shields', rank: 'astartes', tint: '#111111',
  };
  const checkpoint = {
    seq: 1, entity_type: 'estate', entity_id: 'maintained-projection', event_type: 'estate.compaction_checkpoint',
    payload: {
      current_bindings: [], seat_board: [], open_contradictions: [], turn_by_agent: [], ever_bound_agents: [],
      physical_declarations: [declaration], placement_attested_agents: [], abandoned_seats: [],
      launch_compositions: [], transport_claims: [],
    },
    provenance: prov, occurred_at: 't', recorded_at: 't',
  };

  expect(buildProjections([checkpoint as EventRecord]).physicalDeclarations.get(declaration.agent_id) as unknown)
    .toEqual(declaration);
});
test('bare seat create → freelist entry, unbound, live', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'somnium:NE', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  const p = buildProjections(await s.readAll());
  expect(p.freelist).toEqual([{ seat_id: 'somnium:NE', pane_state: 'live' }]);
  expect(p.currentBindings).toEqual([]);
  const row = p.seatBoard[0]!;
  expect(row).toMatchObject({ seat_id: 'somnium:NE', entity_type: 'seat', pane: 'live', binding: 'unbound', turn: 'unobserved' });
  await s.close();
});

test('activity axis folds prompt/stop/retire independently of pane & binding', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatA', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_id: 'seatA', event_type: 'reg.bound', payload: { agent_id: 'iA', persona: 'p', tint: '#1' } }));
  await s.append(e({ entity_type: 'agent', entity_id: 'iA', event_type: 'act.prompt_submitted', payload: {} }));
  let p = buildProjections(await s.readAll());
  expect(p.seatBoard[0]!.turn).toBe('working');
  await s.append(e({ entity_type: 'agent', entity_id: 'iA', event_type: 'act.stop_reported', payload: {} }));
  p = buildProjections(await s.readAll());
  expect(p.seatBoard[0]!.turn).toBe('awaiting_input');
  await s.close();
});

test('seat_cleared returns a live seat to the freelist', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.bound', payload: { agent_id: 'iR', persona: 'p', tint: '#1' } }));
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.seat_cleared', payload: {} }));
  const p = buildProjections(await s.readAll());
  expect(p.currentBindings).toEqual([]);
  expect(p.freelist).toEqual([{ seat_id: 'seatR', pane_state: 'live' }]);
  await s.close();
});

test('seat_cleared releases the launch composition that acquired the seat', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({
    entity_id: 'seatR',
    event_type: 'reg.launch_composed',
    payload: {
      pane_generation: 'pane-generation-1',
      agent_id: 'agent-1',
      launch_nonce: 'nonce-1',
      target_machine: null,
      worktree: null,
    },
  }));
  expect(buildProjections(await s.readAll()).launchCompositions.has('seatR')).toBe(true);

  await s.append(e({ entity_id: 'seatR', event_type: 'reg.seat_cleared', payload: {} }));
  const p = buildProjections(await s.readAll());
  expect(p.launchCompositions.has('seatR')).toBe(false);
  expect(p.freelist).toEqual([{ seat_id: 'seatR', pane_state: 'live' }]);
  await s.close();
});

test('estate rotation completion releases launch occupancy from the replaced estate', async () => {
  const s = new MemoryEventStore();
  for (const seat of ['council:custodes', 'council:orchestrator']) {
    await s.append(e({ entity_id: seat, event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
    await s.append(e({
      entity_id: seat,
      event_type: 'reg.launch_composed',
      payload: {
        pane_generation: `${seat}-generation`,
        agent_id: `${seat}-agent`,
        launch_nonce: `${seat}-nonce`,
        target_machine: seat === 'council:orchestrator' ? 'k12-work' : null,
        worktree: null,
      },
    }));
    await s.append(e({
      entity_id: seat,
      event_type: 'reg.transport_claimed',
      payload: {
        pane_generation: `${seat}-generation`,
        kind: seat === 'council:orchestrator' ? 'ssh' : 'local',
        target_machine: seat === 'council:orchestrator' ? 'k12-work' : null,
        launch_nonce: `${seat}-nonce`,
        envelope_session: null,
      },
    }));
  }
  const beforeRotation = buildProjections(await s.readAll());
  expect(beforeRotation.launchCompositions.size).toBe(2);
  expect(beforeRotation.transportClaims.size).toBe(2);

  await s.append(e({
    entity_type: 'estate',
    entity_id: 'rotation-1',
    event_type: 'estate.rotation_completed',
    payload: { canonical_seats: 16 },
  }));

  const p = buildProjections(await s.readAll());
  expect(p.launchCompositions.size).toBe(0);
  expect(p.transportClaims.size).toBe(0);
  await s.close();
});
