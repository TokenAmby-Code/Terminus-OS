import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { TXD_ESTATE } from '../src/estate.ts';

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
      palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
      somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
      'council:custodes': ['council:custodes'],
      'council:pax': ['council:pax'],
      'council:malcador': ['council:malcador'],
      'council:true-terminal': ['council:true-terminal'],
      'council:administratum': ['council:administratum'],
      'mechanicus:fabricator-general': ['mechanicus:fabricator-general'],
      'mechanicus:orchestrator': ['mechanicus:orchestrator'],
    },
  });

  // Every seat surfaces as an unbound row on the activity board.
  const board = await d.estateRows();
  expect(board).toHaveLength(TXD_ESTATE.length);
  expect(board.map((r) => r.seat_id).sort()).toEqual([...TXD_ESTATE].sort());
  expect(board.every((r) => r.binding === 'unbound')).toBe(true);
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

test('bare unbound seats are healthy — ok, zero contradictions', async () => {
  const { d } = setup();
  await d.constructEstate();

  const h = await d.health('k12-personal', BUILD);
  expect(h.ok).toBe(true);
  expect(h.open_contradictions).toBe(0);
  expect((await d.estateRows()).every((r) => r.binding === 'unbound')).toBe(true);
});
