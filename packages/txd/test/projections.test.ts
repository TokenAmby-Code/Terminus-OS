import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { buildProjections } from '../src/projections.ts';
import type { EventInput } from '@terminus-os/contracts';

const prov = { source: 'wrapper' as const, transport_receipt: null, emitter_version: 1 };
function e(over: Partial<EventInput>): EventInput {
  return { entity_type: 'seat', entity_id: 'x', event_type: 'reg.pane_created', payload: {}, provenance: prov, occurred_at: 't', ...over } as EventInput;
}

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
  expect(buildProjections(await s.readAll()).launchCompositions.size).toBe(2);

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
