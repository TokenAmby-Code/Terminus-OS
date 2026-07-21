import { expect, test } from 'bun:test';
import { Daemon } from '../src/core.ts';
import { buildProjections } from '../src/projections.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { registration } from './registration-fixture.ts';

test('historical projected-only Reservist seats become absent P0 facts, not teardown', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  await d.constructEstate();
  tmux.removeOutOfBand('reservists:W'); tmux.removeOutOfBand('reservists:N');
  const result = await d.reconcile();
  expect(result.open_contradictions.filter((c) => c.kind === 'absent_unbound_projected_seat').map((c) => c.entity_id).sort()).toEqual(['reservists:N', 'reservists:W']);
  const events = await store.readAll();
  expect(events.filter((e) => e.event_type === 'reg.pane_observed' && e.payload.pane_state === 'absent')).toHaveLength(2);
  expect(events.some((e) => e.event_type === 'reg.teardown_started')).toBe(false);
  expect((await d.health('k12-personal', { version: 'x', git_sha: 'x', bun: 'x' })).ok).toBe(false);
});

test('contradiction resolution is explicit and keyed by contradiction sequence and kind', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  await d.constructEstate(); tmux.removeOutOfBand('reservists:W');
  const flagged = (await d.reconcile()).open_contradictions[0]!;
  await tmux.createSeat('reservists:W');
  expect((await d.reconcile()).open_contradictions).toEqual([]);
  const resolution = (await store.readAll()).find((e) => e.event_type === 'reg.contradiction_resolved')!;
  expect(resolution.payload).toEqual({ contradiction_seq: flagged.seq, kind: flagged.kind });
});

test('a physical seat without projection evidence is P0 until observed evidence resolves it', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  await tmux.createSeat('unknown:seat');
  expect((await d.reconcile()).open_contradictions[0]).toMatchObject({ kind: 'physical_seat_missing_projection' });
  expect((await d.reconcile()).open_contradictions).toEqual([]);
});

test('stale readiness cannot activate or deliver a changed generation', async () => {
  const store = new MemoryEventStore(); const tmux = new FakeTmux(); const d = new Daemon(store, tmux);
  const launched = await d.launch(registration('palace:W'));
  await d.suspendRoute({ schema_version: 5, instance_id: 'i1', binding_generation: launched.binding_generation!, reason: 'placement_changed' });
  expect(await d.send({ schema_version: 5, target: 'i1', text: 'blocked' })).toMatchObject({ refused: true, reason: 'route_inactive' });
  expect((await d.activateRoute({ schema_version: 5, instance_id: 'i1', binding_generation: launched.binding_generation! - 1 })).reason).toBe('stale_binding');
});

test('mixed v1-v5 replay never manufactures readiness for an old binding', async () => {
  const store = new MemoryEventStore();
  await store.append({ entity_type: 'seat', entity_id: 'legacy', event_type: 'reg.pane_created', payload: { pane_state: 'live' }, provenance: { source: 'observer', emitter_version: 1 }, occurred_at: 't1' });
  await store.append({ entity_type: 'seat', entity_id: 'legacy', event_type: 'reg.bound', payload: { instance_id: 'old' }, provenance: { source: 'wrapper', emitter_version: 3 }, occurred_at: 't2' });
  const projection = buildProjections(await store.readAll());
  expect(projection.currentBindings[0]).toMatchObject({ registration: 'registered', readiness: 'unready', routing: 'inactive', placement: null });
});
