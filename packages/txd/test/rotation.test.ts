import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import type { EstateRotationBarrier } from '../src/rotation-lock.ts';

async function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  return { store, tmux, daemon };
}

test('non-force rotation refuses bound seats without touching tmux', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:W', schema_version: SCHEMA_VERSION, identity: 'i1', persona: 'p', tint: '#1' });
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: false, scope: 'estate' });
  expect(result).toMatchObject({ accepted: false, reason: 'estate_busy', bound_seats: ['palace:W'] });
  expect(tmux.killed).toBe(false);
  expect((await store.readAll()).at(-1)?.event_type).toBe('estate.rotation_refused');
});

test('non-force rotation refuses a foreground command by canonical seat only', async () => {
  const { tmux, daemon } = await setup();
  tmux.setCommand('somnium:NE', 'codex');
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: false, scope: 'estate' });
  expect(result.foreground_workloads).toEqual([{ seat_id: 'somnium:NE', command: 'codex' }]);
  expect(tmux.killed).toBe(false);
});

test('forced rotation durably records sacrifices before explicit execution', async () => {
  const { store, tmux, daemon } = await setup();
  tmux.setCommand('somnium:NE', 'codex');
  const result = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true, scope: 'estate' });
  expect(result.accepted).toBe(true);
  expect(tmux.killed).toBe(false);
  expect((await store.readAll()).at(-1)?.event_type).toBe('estate.rotation_requested');
  await daemon.executeEstateRotation();
  expect(tmux.killed).toBe(true);
});

test('new daemon generation completes the latest pending rotation once', async () => {
  const { store, daemon } = await setup();
  const request = await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true, scope: 'estate' });
  expect(request.rotation_id).not.toBeNull();
  await daemon.finalizeEstateRotation();
  await daemon.finalizeEstateRotation();
  const completions = (await store.readAll()).filter((event) => event.event_type === 'estate.rotation_completed');
  expect(completions).toHaveLength(1);
  expect(completions[0]?.entity_id).toBe(request.rotation_id!);
});

test('forced rotation holds the lifecycle barrier from durable request through reconstruction', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const calls: string[] = [];
  const barrier: EstateRotationBarrier = {
    async begin() { calls.push('begin'); },
    async complete() { calls.push('complete'); },
    async abort() { calls.push('abort'); },
  };
  const daemon = new Daemon(store, tmux, undefined, barrier);
  await daemon.constructEstate();
  await daemon.requestEstateRotation({ schema_version: SCHEMA_VERSION, force: true, scope: 'estate' });
  expect(calls).toEqual(['begin']);
  await daemon.executeEstateRotation();
  expect(calls).toEqual(['begin']);
  await daemon.finalizeEstateRotation();
  expect(calls).toEqual(['begin', 'complete']);
});

test('forced page reset reconstructs the whole page border, clears every binding, and leaves the daemon alive', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:N', schema_version: SCHEMA_VERSION, identity: 'n', persona: 'n', tint: '#1' });
  await daemon.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'ne', persona: 'ne', tint: '#2' });
  const result = await daemon.resetEstateScope({ schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: 'somnium' });
  expect(result).toMatchObject({ ok: true, accepted: true, scope: 'page', seats: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'] });
  expect(tmux.killed).toBe(false);
  expect(tmux.rebuiltPages()).toEqual(['somnium']);
  expect(tmux.resetSeats()).toEqual([]);
  expect((await daemon.estateRows()).filter((row) => row.seat_id?.startsWith('somnium:')).every((row) => row.binding === 'unbound')).toBe(true);
  expect((await store.readAll()).at(-1)?.event_type).toBe('estate.scoped_reset_completed');
});

test('forced page reset reconstructs a deleted canonical terminal instead of partially resetting survivors', async () => {
  const { tmux, daemon } = await setup();
  tmux.deleteOutOfBand('palace:E');
  const result = await daemon.resetEstateScope({ schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: 'palace' });
  expect(result).toMatchObject({ ok: true, accepted: true, scope: 'page' });
  expect(tmux.estateShape().windows.palace).toEqual(['palace:W', 'palace:N', 'palace:S', 'palace:E']);
  expect(tmux.rebuiltPages()).toEqual(['palace']);
});

test('tmux pane lifecycle event immediately repairs only the lost seat and resolves its binding into event truth', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:E', schema_version: SCHEMA_VERSION, identity: 'east', persona: 'astartes', tint: '#1' });
  tmux.deleteOutOfBand('palace:E');
  const recovered = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-exited', page: 'palace' });
  expect(recovered).toMatchObject({ ok: true, reconstructed: true, page: 'palace', event: 'pane-exited', reset_seats: ['palace:E'] });
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:E']);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'palace:E')).toMatchObject({ binding: 'unbound', pane: 'live' });
  const requested = (await store.readAll()).findLast((event) => event.event_type === 'estate.scoped_reset_requested');
  expect(requested).toMatchObject({ payload: { trigger: 'pane-exited' }, provenance: { source: 'observer' } });
  const duplicate = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-exited', page: 'palace' });
  expect(duplicate).toMatchObject({ ok: true, reconstructed: false, reason: 'page_already_canonical' });
  expect(tmux.rebuiltPages()).toEqual([]);
});

test('a dead pane retires alone: pane-died resets only the faulted pane and bound siblings survive', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:W', schema_version: SCHEMA_VERSION, identity: 'west', persona: 'astartes', tint: '#1' });
  await daemon.launch({ seat_id: 'palace:S', schema_version: SCHEMA_VERSION, identity: 'south', persona: 'astartes', tint: '#2' });
  await tmux.killSeat('palace:S');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'palace' });
  expect(result).toMatchObject({ ok: true, reconstructed: true, reset_seats: ['palace:S'] });
  expect(result.rotation_ids).toHaveLength(1);
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:S']);
  const rows = await daemon.estateRows();
  expect(rows.find((row) => row.seat_id === 'palace:W')).toMatchObject({ binding: 'bound', pane: 'live' });
  expect(rows.find((row) => row.seat_id === 'palace:S')).toMatchObject({ binding: 'unbound', pane: 'live' });
  const events = await store.readAll();
  const requested = events.findLast((event) => event.event_type === 'estate.scoped_reset_requested')!;
  expect(requested.payload).toMatchObject({ scope: 'pane', seats: ['palace:S'], trigger: 'pane-died' });
  expect(events.filter((event) => event.event_type === 'reg.retired').map((event) => event.entity_id)).toEqual(['south']);
});

test('a dead dynamic worker pane is retired and removed immediately on its lifecycle edge', async () => {
  const { store, tmux, daemon } = await setup();
  const seat = 'palace_fleet:11111111-1111-4111-8111-111111111111';
  await tmux.createStackSeat('palace_fleet', seat);
  await store.append({
    entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity: 'worker', persona: 'astartes', tint: '#111111' });
  tmux.killOutOfBand(seat);

  const result = await daemon.handleTmuxLifecycleEvent({
    schema_version: SCHEMA_VERSION,
    event: 'pane-died',
    page: 'palace_fleet',
  });

  expect(result).toMatchObject({ ok: true, reconstructed: true, reset_seats: [seat] });
  expect((await daemon.estateRows()).some((row) => row.seat_id === seat)).toBe(false);
  expect((await store.readByEntity('worker')).map((event) => event.event_type)).toContain('reg.retired');
});

test('boot reconciles a dead dynamic worker instead of failing ensureEstate', async () => {
  const { store, tmux, daemon } = await setup();
  const seat = 'palace_fleet:22222222-2222-4222-8222-222222222222';
  await tmux.createStackSeat('palace_fleet', seat);
  await store.append({
    entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  await daemon.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity: 'worker', persona: 'astartes', tint: '#111111' });
  tmux.killOutOfBand(seat);

  const restarted = new Daemon(store, tmux);
  await expect(restarted.constructEstate()).resolves.toBeDefined();
  expect((await restarted.estateRows()).some((row) => row.seat_id === seat)).toBe(false);
  expect(tmux.estateShape().windows.palace_fleet).not.toContain(seat);
  expect(await tmux.estateGeneration()).toBe('canonical');
});

test('a failed dynamic pane removal cannot fabricate seat abandonment', async () => {
  class FailedDynamicKillTmux extends FakeTmux {
    override async killSeat(_seatId: string): Promise<void> {}
  }
  const store = new MemoryEventStore();
  const tmux = new FailedDynamicKillTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  const seat = 'palace_fleet:33333333-3333-4333-8333-333333333333';
  await tmux.createStackSeat('palace_fleet', seat);
  await store.append({
    entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  tmux.killOutOfBand(seat);

  await expect(daemon.handleTmuxLifecycleEvent({
    schema_version: SCHEMA_VERSION,
    event: 'pane-died',
    page: 'palace_fleet',
  })).rejects.toThrow(`txd could not verify dynamic stack seat cleanup for ${seat}`);

  expect((await store.readByEntity(seat)).some((event) => event.event_type === 'reg.seat_abandoned')).toBe(false);
  expect((await tmux.listSeats()).some((row) => row.seat_id === seat)).toBe(true);
});

test('two dead panes earn two loud pane-scoped resets, never a page rebuild', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:N', schema_version: SCHEMA_VERSION, identity: 'north', persona: 'astartes', tint: '#1' });
  await tmux.killSeat('palace:S');
  await tmux.killSeat('palace:E');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'palace' });
  expect(result).toMatchObject({ ok: true, reconstructed: true, reset_seats: ['palace:S', 'palace:E'] });
  expect(result.rotation_ids).toHaveLength(2);
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:S', 'palace:E']);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'palace:N')).toMatchObject({ binding: 'bound', pane: 'live' });
  const requests = (await store.readAll()).filter((event) => event.event_type === 'estate.scoped_reset_requested');
  expect(requests.map((event) => event.payload.scope)).toEqual(['pane', 'pane']);
});

test('one seat\'s physical reset failure stays open and loud without blocking the sibling corpse\'s repair', async () => {
  class OneSeatDownTmux extends FakeTmux {
    override async resetSeat(seatId: string): Promise<boolean> {
      if (seatId === 'palace:S') return false;
      return super.resetSeat(seatId);
    }
  }
  const store = new MemoryEventStore();
  const tmux = new OneSeatDownTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  await tmux.killSeat('palace:S');
  await tmux.killSeat('palace:E');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'palace' });
  expect(result).toMatchObject({ ok: false, reason: 'reset_failed', reset_seats: ['palace:E'] });
  expect(result.rotation_ids).toHaveLength(2);
  expect(tmux.rebuiltPages()).toEqual([]);
  const events = await store.readAll();
  const open = events.filter((event) => event.event_type === 'estate.scoped_reset_requested');
  const completed = new Set(events.filter((event) => event.event_type === 'estate.scoped_reset_completed').map((event) => event.entity_id));
  expect(open).toHaveLength(2);
  expect(open.filter((event) => !completed.has(event.entity_id)).map((event) => event.payload.seats)).toEqual([['palace:S']]);
});

test('scoped reset refuses busy targets until force is explicit and never widens to another pane', async () => {
  const { tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'ne', persona: 'ne', tint: '#1' });
  const refused = await daemon.resetEstateScope({ schema_version: SCHEMA_VERSION, force: false, scope: 'pane', pane: 'somnium:NE' });
  expect(refused).toMatchObject({ accepted: false, reason: 'estate_busy', seats: ['somnium:NE'] });
  expect(tmux.resetSeats()).toEqual([]);
  const reset = await daemon.resetEstateScope({ schema_version: SCHEMA_VERSION, force: true, scope: 'pane', pane: 'somnium:NE' });
  expect(reset).toMatchObject({ accepted: true, scope: 'pane', seats: ['somnium:NE'] });
  expect(tmux.resetSeats()).toEqual(['somnium:NE']);
});

test('boot resumes a pending pane reconstruction and retires its exact binding', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'ne', persona: 'ne', tint: '#1' });
  const bound = (await store.readAll()).find((event) =>
    event.entity_id === 'somnium:NE' && event.event_type === 'reg.bound',
  )!;
  const resetId = crypto.randomUUID();
  await store.append({
    entity_type: 'estate',
    entity_id: resetId,
    event_type: 'estate.scoped_reset_requested',
    payload: {
      scope: 'pane',
      seats: ['somnium:NE'],
      force: true,
      bound_seats: ['somnium:NE'],
      bound_generations: [{
        seat_id: 'somnium:NE',
        bound_seq: bound.seq,
        pane_generation: bound.payload.pane_generation,
      }],
      foreground_workloads: [],
      trigger: 'operator',
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });

  const restarted = new Daemon(store, tmux);
  await restarted.constructEstate();

  expect(tmux.resetSeats()).toEqual(['somnium:NE']);
  expect((await restarted.estateRows()).find((row) => row.seat_id === 'somnium:NE')).toMatchObject({
    binding: 'unbound',
  });
  expect((await store.readAll()).filter((event) =>
    event.entity_id === 'ne' && event.event_type === 'reg.retired',
  )).toHaveLength(1);
  expect((await store.readAll()).filter((event) =>
    event.entity_id === resetId && event.event_type === 'estate.scoped_reset_completed',
  )).toHaveLength(1);
});

test('reconcile resumes an admitted scoped reset after a transient physical failure', async () => {
  class FlakyResetTmux extends FakeTmux {
    private failures = 1;
    override async resetSeat(seatId: string): Promise<boolean> {
      if (this.failures-- > 0) return false;
      return super.resetSeat(seatId);
    }
  }
  const store = new MemoryEventStore();
  const tmux = new FlakyResetTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  await daemon.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'ne', persona: 'ne', tint: '#1' });

  const reset = await daemon.resetEstateScope({
    schema_version: SCHEMA_VERSION,
    force: true,
    scope: 'pane',
    pane: 'somnium:NE',
  });
  expect(reset).toMatchObject({ ok: false, accepted: false, reason: 'reset_failed' });

  await daemon.reconcile();

  expect(tmux.resetSeats()).toEqual(['somnium:NE']);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'somnium:NE')).toMatchObject({
    binding: 'unbound',
  });
  expect((await store.readAll()).filter((event) =>
    event.entity_id === reset.rotation_id && event.event_type === 'estate.scoped_reset_completed',
  )).toHaveLength(1);
});

test('boot closes an unresumable scoped reset without touching the current binding', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'ne', persona: 'ne', tint: '#1' });
  const resetId = crypto.randomUUID();
  await store.append({
    entity_type: 'estate',
    entity_id: resetId,
    event_type: 'estate.scoped_reset_requested',
    payload: {
      scope: 'pane',
      seats: ['somnium:NE'],
      force: true,
      bound_seats: ['somnium:NE'],
      foreground_workloads: [],
      trigger: 'operator',
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });

  const restarted = new Daemon(store, tmux);
  await restarted.constructEstate();

  expect(tmux.resetSeats()).toEqual([]);
  expect((await restarted.estateRows()).find((row) => row.seat_id === 'somnium:NE')).toMatchObject({
    binding: 'bound',
    entity_id: 'ne',
  });
  expect(await tmux.seatTint('somnium:NE')).toBe('#1');
  expect((await store.readAll()).filter((event) =>
    event.entity_id === resetId && event.event_type === 'estate.scoped_reset_failed',
  )).toHaveLength(1);
});

test('a pending scoped reset fences new bindings and sends on every reserved seat', async () => {
  const { store, tmux, daemon } = await setup();
  await store.append({
    entity_type: 'estate',
    entity_id: 'pending-unbound-reset',
    event_type: 'estate.scoped_reset_requested',
    payload: {
      scope: 'pane',
      seats: ['somnium:NE'],
      force: true,
      bound_seats: [],
      bound_generations: [],
      foreground_workloads: [],
      trigger: 'operator',
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  const before = await store.count();

  expect(await daemon.launch({
    seat_id: 'somnium:NE',
    schema_version: SCHEMA_VERSION,
    identity: 'late',
    persona: 'late',
    tint: '#1',
  })).toMatchObject({ ok: false, handover: false, reason: 'scoped_reset_pending: somnium:NE' });
  expect(await store.count()).toBe(before);
  expect(await tmux.seatTint('somnium:NE')).toBeNull();
});
