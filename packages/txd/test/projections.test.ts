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
  const row = p.activityBoard[0]!;
  expect(row).toMatchObject({ seat_id: 'somnium:NE', entity_type: 'seat', pane: 'live', binding: 'unbound', activity: 'idle', queue_depth: 0 });
  await s.close();
});

test('bound seat leaves the freelist and carries the full tuple', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'palace:W', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  const bound = await s.append(e({ entity_id: 'palace:W', event_type: 'reg.bound', payload: { wrapper_id: 'w1', instance_id: 'i1', persona: 'salamander', tint: '#302800' } }));
  const p = buildProjections(await s.readAll());
  expect(p.freelist).toEqual([]);
  expect(p.currentBindings).toHaveLength(1);
  expect(p.currentBindings[0]).toMatchObject({ seat_id: 'palace:W', wrapper_id: 'w1', instance_id: 'i1', persona: 'salamander', tint: '#302800', bound_seq: bound.seq, readiness: 'unready', routing: 'inactive' });
  const row = p.activityBoard[0]!;
  expect(row).toMatchObject({ entity_id: 'i1', entity_type: 'instance', binding: 'bound', persona: 'salamander', tint: '#302800' });
  await s.close();
});

test('activity axis folds prompt/stop/retire independently of pane & binding', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatA', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_id: 'seatA', event_type: 'reg.bound', payload: { instance_id: 'iA', persona: 'p', tint: '#1' } }));
  await s.append(e({ entity_type: 'instance', entity_id: 'iA', event_type: 'act.prompt_submitted', payload: {} }));
  let p = buildProjections(await s.readAll());
  expect(p.activityBoard[0]!.activity).toBe('working');
  await s.append(e({ entity_type: 'instance', entity_id: 'iA', event_type: 'act.stop_reported', payload: {} }));
  p = buildProjections(await s.readAll());
  expect(p.activityBoard[0]!.activity).toBe('stopped');
  await s.close();
});

test('queue_depth is a projection column: enqueued +1, delivered/cancelled -1, gated no-op', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatQ', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_type: 'send', entity_id: 's1', event_type: 'act.send_enqueued', payload: { target: 'seatQ' } }));
  await s.append(e({ entity_type: 'send', entity_id: 's2', event_type: 'act.send_enqueued', payload: { target: 'seatQ' } }));
  await s.append(e({ entity_type: 'send', entity_id: 's2', event_type: 'act.send_gated', payload: { target: 'seatQ', reason: 'typing_guard' } }));
  let p = buildProjections(await s.readAll());
  expect(p.activityBoard.find((r) => r.seat_id === 'seatQ')!.queue_depth).toBe(2);
  await s.append(e({ entity_type: 'send', entity_id: 's1', event_type: 'act.send_delivered', payload: { target: 'seatQ', bytes: 3 } }));
  p = buildProjections(await s.readAll());
  expect(p.activityBoard.find((r) => r.seat_id === 'seatQ')!.queue_depth).toBe(1);
  await s.append(e({ entity_type: 'send', entity_id: 's2', event_type: 'act.send_cancelled', payload: { target: 'seatQ', reason: 'binding_changed' } }));
  p = buildProjections(await s.readAll());
  expect(p.activityBoard.find((r) => r.seat_id === 'seatQ')!.queue_depth).toBe(0);
  await s.close();
});

test('seat_cleared returns a live seat to the freelist', async () => {
  const s = new MemoryEventStore();
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.pane_created', payload: { pane_state: 'live' } }));
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.bound', payload: { instance_id: 'iR', persona: 'p', tint: '#1' } }));
  await s.append(e({ entity_id: 'seatR', event_type: 'reg.seat_cleared', payload: {} }));
  const p = buildProjections(await s.readAll());
  expect(p.currentBindings).toEqual([]);
  expect(p.freelist).toEqual([{ seat_id: 'seatR', pane_state: 'live' }]);
  await s.close();
});
