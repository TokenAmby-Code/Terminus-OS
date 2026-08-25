import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { TXD_ESTATE } from '../src/estate.ts';

const STABLE_SEAT_IDS = [
  'mechanicus:new',
  'palace:W', 'palace:N', 'palace:S', 'palace:E',
  'somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE',
  'council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator',
  'palace_fleet:new', 'somnium_fleet:new',
] as const;

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  return { store, tmux, d: new Daemon(store, tmux) };
}

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
      mechanicus: ['mechanicus:new'],
      palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
      somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
      council: ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'],
      palace_fleet: ['palace_fleet:new'],
      somnium_fleet: ['somnium_fleet:new'],
    },
  });

  // Every seat surfaces as an unbound row on the activity board.
  const board = await d.estateRows();
  expect(board).toHaveLength(TXD_ESTATE.length);
  expect(board.map((r) => r.seat_id).sort()).toEqual([...TXD_ESTATE].sort());
  expect(board.every((r) => r.binding === 'unbound')).toBe(true);
});

test('canonical seat ids pin compass seats and mitosis allocation panes', () => {
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

  expect((await tmux.listSeats()).some((seat) => seat.seat_id === 'somnium:NE')).toBe(true);
  expect(await tmux.reapSeat('palace:S')).toBe(true);
  expect((await tmux.listSeats()).map((seat) => seat.seat_id).sort()).toEqual([...TXD_ESTATE].sort());
});

test('stack recovery revives one dead allocation pane without replacing a live worker', async () => {
  const { tmux } = setup();
  await tmux.ensureEstate();
  await tmux.createStackSeat('palace_fleet', 'palace_fleet:worker-1');
  tmux.killOutOfBand('palace_fleet:new');

  expect(await tmux.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [], diverged_pages: [] });
  expect(tmux.resetSeats()).toContain('palace_fleet:new');
  expect(tmux.estateShape().windows.palace_fleet).toEqual([
    'palace_fleet:new',
    'palace_fleet:worker-1',
  ]);
  expect((await tmux.listSeats()).filter((seat) => seat.seat_id === 'palace_fleet:new')).toEqual([
    { seat_id: 'palace_fleet:new', pane: 'live' },
  ]);
});

test('refuses a non-canonical existing estate without mutation or events', async () => {
  const { store, tmux, d } = setup();
  tmux.seedNonCanonicalEstate();

  await expect(d.constructEstate()).rejects.toThrow('non-canonical existing tmux estate');
  expect(await store.count()).toBe(0);
  expect(tmux.estateShape()).toEqual({ sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } });
});

test('boot defers a foreign pre-rotation shape without mutating or resolving it', async () => {
  const { store, tmux, d } = setup();
  tmux.seedNonCanonicalEstate();

  expect(await d.constructEstateAtBoot()).toBeNull();
  expect(await store.count()).toBe(0);
  expect(tmux.estateShape()).toEqual({ sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } });

  const health = await d.health('k12-personal', { version: '0.1.0', git_sha: 'head', bun: Bun.version });
  expect(health).toMatchObject({
    ok: false,
    estate_generation: 'foreign',
    activation_pending: true,
    tmux_reachable: true,
  });
});

test('boot repairs a seat deleted while txd was down alone, in place, without rebuilding its page', async () => {
  const { store, tmux, d } = setup();
  await d.constructEstate();
  await d.launch({
    seat_id: 'palace:E',
    schema_version: SCHEMA_VERSION,
    identity: 'boot-wiped',
    persona: 'astartes',
    tint: '#1',
  });
  await d.launch({
    seat_id: 'palace:W',
    schema_version: SCHEMA_VERSION,
    identity: 'boot-survivor',
    persona: 'astartes',
    tint: '#2',
  });
  tmux.deleteOutOfBand('palace:E');
  const result = await d.constructEstate();
  expect(result.failed).toEqual([]);
  // The faulted seat is the fault scope; its live siblings keep their processes.
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:E']);
  expect([...tmux.estateShape().windows.palace ?? []].sort()).toEqual(['palace:E', 'palace:N', 'palace:S', 'palace:W']);
  const rows = await d.estateRows();
  expect(rows.find((row) => row.seat_id === 'palace:E')).toMatchObject({ binding: 'unbound', pane: 'live' });
  expect(rows.find((row) => row.seat_id === 'palace:W')).toMatchObject({ binding: 'bound', pane: 'live' });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.retired').map((event) => event.entity_id)).toEqual(['boot-wiped']);
  expect(events.filter((event) => event.event_type === 'estate.scoped_reset_requested')).toMatchObject([
    { payload: { scope: 'pane', seats: ['palace:E'], trigger: 'boot' } },
  ]);
  const health = await d.health('k12-personal', { version: '0.1.0', git_sha: 'head', bun: Bun.version });
  expect(health).toMatchObject({ ok: true, estate_generation: 'canonical', estate_divergence: [], open_contradictions: 0 });
});

// RULING (Emperor, 2026-08-25): a restart is not the sensitive operation;
// closing panes is. A txd restart arrives with every merge in its closure, so
// boot never rebuilds a page that still holds live workloads to correct drift.
test('a drifted Council carrying live bound workloads survives boot; health goes red naming the page and clause', async () => {
  const { store, tmux, d } = setup();
  await d.constructEstate();
  for (const [seat, identity] of [['council:custodes', 'overseer-a'], ['council:pax', 'overseer-b']] as const) {
    await d.launch({ seat_id: seat, schema_version: SCHEMA_VERSION, identity, persona: 'astartes', tint: '#3' });
  }
  const generations = new Map(await Promise.all(
    ['council:custodes', 'council:pax', 'council:fabricator-general', 'council:orchestrator']
      .map(async (seat) => [seat, await tmux.seatGeneration(seat)] as const),
  ));
  tmux.driftPageGeometry('council');
  expect(await tmux.estateGeneration()).toBe('recoverable');
  const retiredBefore = (await store.readAll()).filter((event) => event.event_type === 'reg.retired').length;

  const result = await d.constructEstate();
  expect(result.failed).toEqual([]);
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual([]);
  for (const [seat, generation] of generations) expect(await tmux.seatGeneration(seat)).toBe(generation);
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.retired').length).toBe(retiredBefore);
  expect(events.filter((event) => event.event_type === 'estate.scoped_reset_requested')).toEqual([]);
  expect((await d.estateRows()).filter((row) => row.seat_id?.startsWith('council:') && row.binding === 'bound').map((row) => row.seat_id).sort())
    .toEqual(['council:custodes', 'council:pax']);

  const health = await d.health('k12-personal', { version: '0.1.0', git_sha: 'head', bun: Bun.version });
  expect(health).toMatchObject({
    ok: false,
    estate_generation: 'recoverable',
    estate_divergence: [{ page: 'council', clause: 'geometry' }],
    open_contradictions: 1,
  });
  const flagged = events.filter((event) => event.event_type === 'reg.contradiction_flagged');
  expect(flagged).toMatchObject([{ entity_type: 'estate', entity_id: 'council', payload: { kind: 'page_drift', clause: 'geometry' } }]);

  // A second boot over the same drift re-flags nothing; an operator repair
  // that makes the page canonical again closes the contradiction.
  await d.constructEstate();
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.contradiction_flagged')).toHaveLength(1);
  expect(await d.resetEstateScope({ schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: 'council' })).toMatchObject({ ok: true });
  await d.reconcile();
  expect((await store.readAll()).filter((event) => event.event_type === 'estate.page_canonical_observed')).toMatchObject([{ entity_id: 'council' }]);
  expect(await d.health('k12-personal', { version: '0.1.0', git_sha: 'head', bun: Bun.version })).toMatchObject({
    ok: true, estate_generation: 'canonical', estate_divergence: [], open_contradictions: 0,
  });
});

test('boot still rebuilds a page with no live tagged pane left', async () => {
  const { store, tmux, d } = setup();
  await d.constructEstate();
  await d.launch({ seat_id: 'somnium:NE', schema_version: SCHEMA_VERSION, identity: 'page-lost', persona: 'astartes', tint: '#4' });
  for (const seat of ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE']) tmux.deleteOutOfBand(seat);

  const result = await d.constructEstate();
  expect(result.failed).toEqual([]);
  expect(tmux.rebuiltPages()).toEqual(['somnium']);
  expect([...tmux.estateShape().windows.somnium ?? []].sort()).toEqual(['somnium:N', 'somnium:NE', 'somnium:S', 'somnium:SE', 'somnium:W']);
  expect((await d.estateRows()).find((row) => row.seat_id === 'somnium:NE')).toMatchObject({ binding: 'unbound', pane: 'live' });
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.retired').map((event) => event.entity_id)).toEqual(['page-lost']);
  expect(await d.health('k12-personal', { version: '0.1.0', git_sha: 'head', bun: Bun.version })).toMatchObject({ ok: true, estate_divergence: [] });
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
  expect(await store.count()).toBe(before + (TXD_ESTATE.length - pre.length));
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
