import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';

function setup() {
  const store = new MemoryEventStore();
  return { store, d: new Daemon(store, new FakeTmux()) };
}

// Spec §4: reg-audit is a LAUNCH PHASE. The endpoint creates a seat but refuses
// handover unless every attestation-defined-so-far is present. Binding is atomic.

test('missing attestation refuses before pane creation or binding', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  const res = await d.launch({ seat_id: 'somnium:NE', schema_version: 3, identity: 'i1', persona: 'p' }); // tint missing
  expect(res.handover).toBe(false);
  expect(res.missing_attestations).toEqual(['tint']);
  expect(await tmux.listSeats()).toEqual([]);
  expect(await store.count()).toBe(0);
});

test('exact repeat launch is successful and appends no duplicate event', async () => {
  const { store, d } = setup();
  const launch = { seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' };
  expect((await d.launch(launch)).ok).toBe(true);
  const before = await store.count();

  const repeated = await d.launch(launch);

  expect(repeated).toMatchObject({ ok: true, handover: true, reason: null });
  expect(await store.count()).toBe(before);
});

test('occupied seat refuses a different instance without tmux or event mutation', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const d = new Daemon(store, tmux);
  await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const beforeEvents = await store.count();
  const beforeSeats = await tmux.listSeats();

  const refused = await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i2', persona: 'custodes', tint: '#c9a227' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('seat_occupied');
  expect(await store.count()).toBe(beforeEvents);
  expect(await tmux.listSeats()).toEqual(beforeSeats);
});

test('same instance with changed attestations is not an exact repeat', async () => {
  const { store, d } = setup();
  await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const before = await store.count();

  const refused = await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'custodes', tint: '#c9a227' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('seat_occupied');
  expect(await store.count()).toBe(before);
});

test('one instance cannot bind to multiple seats', async () => {
  const { store, d } = setup();
  await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' });
  const before = await store.count();

  const refused = await d.launch({ seat_id: 'somnium:NE', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' });

  expect(refused).toMatchObject({ ok: false, handover: false });
  expect(refused.reason).toContain('instance_already_bound');
  expect(await store.count()).toBe(before);
});

test('full attestation tuple hands over with ONE atomic bound event', async () => {
  const { store, d } = setup();
  const res = await d.launch({ seat_id: 'palace:W', schema_version: 3, identity: 'i1', persona: 'salamander', tint: '#302800' });
  expect(res.handover).toBe(true);
  expect(res.missing_attestations).toEqual([]);
  const bound = (await store.readAll()).filter((e) => e.event_type === 'reg.bound');
  expect(bound).toHaveLength(1);
  expect(bound[0]!.payload).toMatchObject({ instance_id: 'i1', persona: 'salamander', tint: '#302800' });
});

test('binds an existing estate seat without attempting a duplicate pane creation', async () => {
  const { store, d } = setup();
  await d.constructEstate();
  const before = (await store.readAll()).filter((e) => e.entity_id === 'council:custodes' && e.event_type === 'reg.pane_created');
  const res = await d.launch({
    seat_id: 'council:custodes',
    schema_version: 3,
    identity: 'k12p:redub-custodes',
    persona: 'custodes',
    rank: 'overseer',
    commander: 'council:custodes',
    tint: '#c9a227',
  });
  expect(res.handover).toBe(true);
  const after = (await store.readAll()).filter((e) => e.entity_id === 'council:custodes' && e.event_type === 'reg.pane_created');
  expect(after).toHaveLength(before.length);
  expect((await d.estateRows()).find((r) => r.seat_id === 'council:custodes')).toMatchObject({
    binding: 'bound',
    persona: 'custodes',
    rank: 'overseer',
    commander: 'council:custodes',
  });
});

test('schema_version mismatch refuses loud, no seat, no bind', async () => {
  const { store, d } = setup();
  const res = await d.launch({ seat_id: 'x', schema_version: 999, identity: 'i', persona: 'p', tint: '#1' });
  expect(res.handover).toBe(false);
  expect(res.reason).toContain('schema_version_mismatch');
  expect(await store.count()).toBe(0);
});
