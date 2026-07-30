import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import type { EventInput } from '@terminus-os/contracts';

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  return { store, tmux, d: new Daemon(store, tmux) };
}

// Spec §4: reg-audit is a LAUNCH PHASE. The endpoint creates a seat but refuses
// handover unless every attestation-defined-so-far is present. Binding is atomic.

test('missing attestation refuses before pane creation or binding', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  const res = await d.launch({ seat_id: 'somnium:NE', schema_version: 10, identity: 'i1', persona: 'p' }); // tint missing
  expect(res.handover).toBe(false);
  expect(res.missing_attestations).toEqual(['tint']);
  expect(await tmux.listSeats()).toEqual([]);
  expect(await store.count()).toBe(0);
});

test('exact repeat launch is successful and appends no duplicate event', async () => {
  const { store, d } = setup();
  const launch = { seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' };
  expect((await d.launch(launch)).ok).toBe(true);
  const before = await store.count();

  const repeated = await d.launch(launch);

  expect(repeated).toMatchObject({ ok: true, handover: true, reason: null });
  expect(await store.count()).toBe(before);
});

test('occupied seat refuses a different agent without tmux or event mutation', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const beforeEvents = await store.count();
  const beforeSeats = await tmux.listSeats();

  const refused = await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i2', persona: 'custodes', tint: '#c9a227' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('seat_occupied');
  expect(await store.count()).toBe(beforeEvents);
  expect(await tmux.listSeats()).toEqual(beforeSeats);
});

test('same agent with changed attestations is not an exact repeat', async () => {
  const { store, d } = setup();
  await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const before = await store.count();

  const refused = await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'custodes', tint: '#c9a227' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('seat_occupied');
  expect(await store.count()).toBe(before);
});

test('one agent cannot bind to multiple seats', async () => {
  const { store, d } = setup();
  await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const before = await store.count();

  const refused = await d.launch({ seat_id: 'somnium:NE', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('agent_already_bound');
  expect(await store.count()).toBe(before);
});

test('full attestation tuple hands over with ONE atomic bound event', async () => {
  const { store, tmux, d } = setup();
  const res = await d.launch({ seat_id: 'palace:W', schema_version: 10, identity: 'i1', persona: 'salamander', tint: '#302800' });
  expect(res.handover).toBe(true);
  expect(res.missing_attestations).toEqual([]);
  expect(await tmux.seatTint('palace:W')).toBe('#302800');
  const bound = (await store.readAll()).filter((e) => e.event_type === 'reg.bound');
  expect(bound).toHaveLength(1);
  expect(bound[0]!.payload).toMatchObject({ agent_id: 'i1', persona: 'salamander', tint: '#302800' });
});

test('physical tint failure compensates fail-dark and never commits reg.bound', async () => {
  const { store, tmux, d } = setup();
  tmux.failTintSeat('palace:W');

  const res = await d.launch({
    seat_id: 'palace:W',
    schema_version: 10,
    identity: 'i1',
    persona: 'salamander',
    tint: '#302800',
  });

  expect(res).toMatchObject({ ok: false, handover: false, reason: 'tint_attestation_failed' });
  expect(await tmux.seatTint('palace:W')).toBeNull();
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
});

test('wrong physical tint read-back compensates fail-dark and never commits reg.bound', async () => {
  const { store, tmux, d } = setup();
  tmux.misapplyTintSeat('palace:W');

  const res = await d.launch({
    seat_id: 'palace:W',
    schema_version: 10,
    identity: 'i1',
    persona: 'salamander',
    tint: '#302800',
  });

  expect(res).toMatchObject({ ok: false, handover: false, reason: 'tint_attestation_failed' });
  expect(await tmux.seatTint('palace:W')).toBeNull();
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
});

test('event-store failure after tint application compensates the pane fail-dark', async () => {
  class FailingBoundStore extends MemoryEventStore {
    override append(input: EventInput) {
      if (input.event_type === 'reg.bound') return Promise.reject(new Error('forced reg.bound failure'));
      return super.append(input);
    }
  }
  const store = new FailingBoundStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);

  await expect(d.launch({
    seat_id: 'palace:W',
    schema_version: 10,
    identity: 'i1',
    persona: 'salamander',
    tint: '#302800',
  })).rejects.toThrow('forced reg.bound failure');

  expect(await tmux.seatTint('palace:W')).toBeNull();
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.binding_aborted')).toHaveLength(1);
});

test('binding cleanup attempts abort and preserves the commit error when tint clear fails', async () => {
  class FailingBoundStore extends MemoryEventStore {
    override append(input: EventInput) {
      if (input.event_type === 'reg.bound') return Promise.reject(new Error('forced reg.bound failure'));
      return super.append(input);
    }
  }
  const store = new FailingBoundStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  tmux.failTintClearSeat('palace:W');

  await expect(d.launch({
    seat_id: 'palace:W',
    schema_version: 10,
    identity: 'i1',
    persona: 'salamander',
    tint: '#302800',
  })).rejects.toThrow('forced reg.bound failure');

  expect(await tmux.seatTint('palace:W')).toBe('#302800');
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.binding_aborted')).toHaveLength(1);
});

test('boot clears a prepared tint left by a crash before reg.bound', async () => {
  const { store, tmux, d } = setup();
  await d.constructEstate();
  const paneGeneration = await tmux.seatGeneration('palace:W');
  await store.append({
    entity_type: 'seat',
    entity_id: 'palace:W',
    event_type: 'reg.binding_prepared',
    payload: {
      prepare_id: 'crashed-prepare',
      seat_id: 'palace:W',
      pane_generation: paneGeneration,
      agent_id: 'i-crashed',
      persona: 'salamander',
      tint: '#302800',
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: 8 },
    occurred_at: new Date().toISOString(),
  });
  await tmux.setSeatTint('palace:W', '#302800');

  const restarted = new Daemon(store, tmux);
  await restarted.constructEstate();

  expect(await tmux.seatTint('palace:W')).toBeNull();
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'reg.binding_aborted' && event.payload.prepare_id === 'crashed-prepare',
  )).toHaveLength(1);
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
});

test('exact repeat refuses a stale pane generation even when the tint still matches', async () => {
  const { tmux, d } = setup();
  const launch = { seat_id: 'palace:W', schema_version: 10 as const, identity: 'i1', persona: 'salamander', tint: '#302800' };
  await d.launch(launch);
  tmux.forceSeatGeneration('palace:W', 'replacement-generation');

  expect(await d.launch(launch)).toMatchObject({
    ok: false,
    handover: false,
    reason: 'binding_physical_attestation_mismatch',
  });
});

test('binds an existing estate seat without attempting a duplicate pane creation', async () => {
  const { store, d } = setup();
  await d.constructEstate();
  const before = (await store.readAll()).filter((e) => e.entity_id === 'palace:W' && e.event_type === 'reg.pane_created');
  const res = await d.launch({
    seat_id: 'palace:W',
    schema_version: 10,
    identity: 'k12p:worker',
    persona: 'worker',
    rank: 'overseer',
    commander: 'council:custodes',
    tint: '#c9a227',
  });
  expect(res.handover).toBe(true);
  const after = (await store.readAll()).filter((e) => e.entity_id === 'palace:W' && e.event_type === 'reg.pane_created');
  expect(after).toHaveLength(before.length);
  expect((await d.estateRows()).find((r) => r.seat_id === 'palace:W')).toMatchObject({
    binding: 'bound',
    persona: 'worker',
    rank: 'overseer',
    commander: 'council:custodes',
  });
});

test('schema_version mismatch refuses loud, no seat, no bind', async () => {
  const { store, d } = setup();
  const res = await d.launch({ seat_id: 'x', schema_version: 1099, identity: 'i', persona: 'p', tint: '#1' });
  expect(res.handover).toBe(false);
  expect(res.reason).toContain('schema_version_mismatch');
  expect(await store.count()).toBe(0);
});
