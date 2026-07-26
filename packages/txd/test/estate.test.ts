import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { TXD_ESTATE } from '../src/estate.ts';

const STABLE_SEAT_IDS = [
  'reservists:W', 'reservists:N', 'reservists:S', 'reservists:E',
  'palace:W', 'palace:N', 'palace:S', 'palace:E',
  'somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE',
  'council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator',
] as const;

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  return { store, tmux, d: new Daemon(store, tmux) };
}

const BUILD = { version: '0', git_sha: 'x', bun: 'y' };

// Seed a seat as present-AND-attested the way constructEstate itself would (pane
// on tmux + a reg.pane_created fact in the stream) — the true "already done" state.
async function seedAttested(store: MemoryEventStore, tmux: FakeTmux, seat: string) {
  await tmux.createSeat(seat);
  await store.append({
    entity_type: 'seat',
    entity_id: seat,
    event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
}

// Rung 2: the typed constructor stands the canonical estate declaratively and
// idempotently. NO manual `tmux new-session` — the constructor IS the deliverable.

test('stands the full estate from empty — one pane_created per seat', async () => {
  const { store, tmux, d } = setup();
  const res = await d.constructEstate();

  expect(res.created).toEqual([...TXD_ESTATE]);
  expect(res.existing).toEqual([]);
  expect(res.backfilled).toEqual([]);
  expect(res.failed).toEqual([]);

  const created = (await store.readAll()).filter((e) => e.event_type === 'reg.pane_created');
  expect(created).toHaveLength(TXD_ESTATE.length);
  expect(tmux.estateShape()).toEqual({
    sessions: ['main'],
    windows: {
      reservists: ['reservists:W', 'reservists:N', 'reservists:S', 'reservists:E'],
      palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
      somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
      council: ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'],
    },
  });

  // Every seat surfaces as an unbound row on the activity board.
  const board = await d.estateRows();
  expect(board).toHaveLength(TXD_ESTATE.length);
  expect(board.map((r) => r.seat_id).sort()).toEqual([...TXD_ESTATE].sort());
  expect(board.every((r) => r.binding === 'unbound')).toBe(true);
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.seat_decommissioned')).toHaveLength(5);

  const before = await store.count();
  const oldSeat = await d.launch({
    seat_id: 'mechanicus:fabricator-general',
    schema_version: SCHEMA_VERSION,
    identity: 'forged-old-fg',
    persona: 'fabricator-general',
    tint: '#1',
  });
  expect(oldSeat.reason).toContain('seat_decommissioned');
  expect(await store.count()).toBe(before);
});

test('canonical seat ids pin the four-seat Council generation', () => {
  expect(TXD_ESTATE).toEqual(STABLE_SEAT_IDS);
});

test('idempotent re-run — second pass creates nothing, appends no events', async () => {
  const { store, d } = setup();
  await d.constructEstate();
  const afterFirst = await store.count();

  const res = await d.constructEstate();
  expect(res.created).toEqual([]);
  expect(res.existing).toEqual([...TXD_ESTATE]);
  expect(res.backfilled).toEqual([]);
  expect(res.failed).toEqual([]);
  expect(await store.count()).toBe(afterFirst); // zero new events on a full, attested estate
});

test('canonical ids resolve to seats inside the shared session windows', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();

  expect(await tmux.sendToSeat('somnium:NE', 'hello')).toMatchObject({ verdict: 'delivered' });
  expect(await tmux.reapSeat('palace:S')).toBe(true);
  expect((await tmux.listSeats()).map((seat) => seat.seat_id).sort()).toEqual([...TXD_ESTATE].sort());
});

test('refuses a non-canonical existing estate without mutation or events', async () => {
  const { store, tmux, d } = setup();
  tmux.seedNonCanonicalEstate();

  await expect(d.constructEstate()).rejects.toThrow('non-canonical existing tmux estate');
  expect(await store.count()).toBe(0);
  expect(tmux.estateShape()).toEqual({ sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } });
});

test('refuses the legacy decomposed estate without mutation or events', async () => {
  const { store, tmux, d } = setup();
  tmux.seedLegacyEstate();

  await expect(d.constructEstate()).rejects.toThrow('non-canonical existing tmux estate');
  expect(await store.count()).toBe(0);
  expect(tmux.estateShape().windows).toHaveProperty('council:custodes');
  expect(tmux.estateShape().windows).not.toHaveProperty('reservists');
});

test('migrates only the exact Council plus Mechanicus generation and decommissions its retired addresses', async () => {
  const { store, tmux, d } = setup();
  tmux.seedCouncilMechanicusEstate();
  await store.append({
    entity_type: 'seat',
    entity_id: 'council:custodes',
    event_type: 'reg.bound',
    payload: {
      wrapper_id: null,
      instance_id: 'old-custodes',
      persona: 'custodes',
      tint: '#1',
      rank: null,
      commander: null,
    },
    provenance: { source: 'wrapper', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  await d.launch({
    seat_id: 'mechanicus:fabricator-general',
    schema_version: SCHEMA_VERSION,
    identity: 'old-fg',
    persona: 'fabricator-general',
    tint: '#2',
  });

  await d.constructEstate();

  expect(tmux.estateShape().windows).toEqual({
    reservists: ['reservists:W', 'reservists:N', 'reservists:S', 'reservists:E'],
    palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
    somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
    council: ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'],
  });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'estate.topology_migration_requested')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'estate.topology_migration_completed')).toHaveLength(1);
  expect(events.filter((event) => event.event_type === 'reg.seat_decommissioned').map((event) => event.entity_id).sort()).toEqual([
    'council:administratum',
    'council:malcador',
    'council:true-terminal',
    'mechanicus:fabricator-general',
    'mechanicus:orchestrator',
  ]);
  expect((await d.estateRows()).some((row) => row.seat_id === 'mechanicus:fabricator-general')).toBe(false);
  expect((await d.estateRows()).find((row) => row.seat_id === 'council:custodes')?.binding).toBe('unbound');

  await d.launch({
    seat_id: 'palace:W',
    schema_version: SCHEMA_VERSION,
    identity: 'source',
    persona: 'worker',
    tint: '#3',
  });
  const communicationEvents = () => store.readAll().then((all) =>
    all.filter((event) => event.event_type === 'reg.comm_accepted' || event.event_type === 'act.comm_bytes_sent'),
  );
  expect(d.comm({
    schema_version: SCHEMA_VERSION,
    source_instance_id: 'source',
    target: 'mechanicus:fabricator-general',
    message: 'must refuse',
    ask: false,
    reply: false,
  })).rejects.toThrow('identity_absent');
  expect(await communicationEvents()).toHaveLength(0);

  const beforeRevival = await store.count();
  const revived = await d.launch({
    seat_id: 'mechanicus:fabricator-general',
    schema_version: SCHEMA_VERSION,
    identity: 'revived-fg',
    persona: 'fabricator-general',
    tint: '#4',
  });
  expect(revived.reason).toContain('seat_decommissioned');
  expect(await store.count()).toBe(beforeRevival);
  expect((await tmux.listSeats()).some((seat) => seat.seat_id === 'mechanicus:fabricator-general')).toBe(false);

  const after = await store.count();
  await d.constructEstate();
  expect(await store.count()).toBe(after);
});

test('resumes the exact interrupted migration only after its durable request', async () => {
  const { store, tmux, d } = setup();
  tmux.seedInterruptedCouncilMigration();
  await store.append({
    entity_type: 'estate',
    entity_id: 'council-static-personas',
    event_type: 'estate.topology_migration_requested',
    payload: { from: 'council-mechanicus', to: 'council' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  await d.constructEstate();
  expect(tmux.estateShape().windows).not.toHaveProperty('mechanicus');
  expect((await store.readAll()).filter((event) => event.event_type === 'estate.topology_migration_completed')).toHaveLength(1);

  const unrequested = setup();
  unrequested.tmux.seedInterruptedCouncilMigration();
  await expect(unrequested.d.constructEstate()).rejects.toThrow('unrequested interrupted Council topology migration');
  expect(await unrequested.store.count()).toBe(0);
});

test('latest migration sequence controls replay after an older completion', async () => {
  const { store, tmux, d } = setup();
  tmux.seedInterruptedCouncilMigration();
  for (const event_type of [
    'estate.topology_migration_requested',
    'estate.topology_migration_completed',
    'estate.topology_migration_requested',
  ] as const) {
    await store.append({
      entity_type: 'estate',
      entity_id: 'council-static-personas',
      event_type,
      payload: { from: 'council-mechanicus', to: 'council' },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: new Date().toISOString(),
    });
  }
  await d.constructEstate();
  expect(tmux.estateShape().windows).not.toHaveProperty('mechanicus');
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'estate.topology_migration_completed',
  )).toHaveLength(2);
});

test('boot constructor reconstructs a damaged canonical page and retires bindings whose processes were wiped', async () => {
  const { store, tmux, d } = setup();
  await d.constructEstate();
  await d.launch({
    seat_id: 'palace:E',
    schema_version: SCHEMA_VERSION,
    identity: 'boot-wiped',
    persona: 'astartes',
    tint: '#1',
  });
  tmux.deleteOutOfBand('palace:E');
  const result = await d.constructEstate();
  expect(result.failed).toEqual([]);
  expect(tmux.rebuiltPages()).toEqual(['palace']);
  expect(tmux.estateShape().windows.palace).toEqual(['palace:W', 'palace:N', 'palace:S', 'palace:E']);
  expect((await d.estateRows()).find((row) => row.seat_id === 'palace:E')).toMatchObject({
    binding: 'unbound',
    pane: 'live',
  });
  expect((await store.readAll()).slice(-3).map((event) => event.event_type)).toEqual([
    'reg.retired',
    'reg.process_reaped',
    'reg.seat_cleared',
  ]);
});

test('boot constructor clears all old bindings when a fresh estate server rebuilds every page', async () => {
  const store = new MemoryEventStore();
  const original = new Daemon(store, new FakeTmux());
  await original.constructEstate();
  await original.launch({
    seat_id: 'somnium:NE',
    schema_version: SCHEMA_VERSION,
    identity: 'volatile-wiped',
    persona: 'astartes',
    tint: '#2',
  });

  const rebuilt = new Daemon(store, new FakeTmux());
  await rebuilt.constructEstate();

  expect((await rebuilt.estateRows()).find((row) => row.seat_id === 'somnium:NE')).toMatchObject({
    binding: 'unbound',
    pane: 'live',
  });
});

test('keeps attested seats and backfills missing facts for an existing canonical estate', async () => {
  const { store, tmux, d } = setup();
  const pre = [TXD_ESTATE[0]!, TXD_ESTATE[5]!, TXD_ESTATE[10]!];
  await tmux.ensureEstate();
  for (const seat of pre) await seedAttested(store, tmux, seat);
  const before = await store.count();

  const res = await d.constructEstate();
  expect(res.existing.sort()).toEqual([...pre].sort());
  expect(res.created).toEqual([]);
  expect(res.backfilled).toEqual(TXD_ESTATE.filter((s) => !pre.includes(s)));
  expect(res.failed).toEqual([]);
  // Only the absent seats appended a new event.
  expect(await store.count()).toBe(before + (TXD_ESTATE.length - pre.length) + 5);
});

test('backfills the torn state — pane present but its pane_created fact was lost', async () => {
  const { store, tmux, d } = setup();
  // Canonical estate on tmux with NO events = a prior boot that committed
  // construction but not its appends. Invisible to projections until repaired.
  await tmux.ensureEstate();

  const res = await d.constructEstate();
  expect(res.backfilled).toEqual([...TXD_ESTATE]);
  expect(res.existing).toEqual([]);
  expect(res.created).toEqual([]);
  expect(res.failed).toEqual([]);

  // Repaired seats now carry their fact and appear on the board.
  const attested = new Set(
    (await store.readAll()).filter((e) => e.event_type === 'reg.pane_created').map((e) => e.entity_id),
  );
  for (const seat of TXD_ESTATE) expect(attested.has(seat)).toBe(true);
  expect(await d.estateRows()).toHaveLength(TXD_ESTATE.length);

  // Re-run is a full idempotent skip — the backfilled seats are now attested.
  const rerun = await d.constructEstate();
  expect(rerun.existing).toEqual([...TXD_ESTATE]);
  expect(rerun.backfilled).toEqual([]);
  expect(rerun.created).toEqual([]);
});

test('bare unbound static seats keep health false while contradictions remain zero', async () => {
  const { d } = setup();
  await d.constructEstate();

  const h = await d.health('k12-personal', BUILD);
  expect(h.ok).toBe(false);
  expect(h.open_contradictions).toBe(0);
  expect(h.static_personas.map((persona) => persona.state)).toEqual(['missing', 'missing']);
  expect((await d.estateRows()).every((r) => r.binding === 'unbound')).toBe(true);
});
