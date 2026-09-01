// Pane-death recovery — behavioral-pin lane.
//
// A remain-on-exit corpse under a bound seat (the persistent/cross-dispatched
// ssh class included) must produce the exact per-seat death transaction —
// retirement, process reap, seat clear — respawn the canonical idle shell
// under a REPLACEMENT pane generation, and only then, after the transaction
// is durable, run one shell `clear` in the replacement idle pane so the dead
// TUI's residue is removed. The clear is cosmetic aftermath: its failure is
// named, never green, and never mutates the recovery verdict.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

async function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  return { store, tmux, daemon };
}

test('a dead bound seat produces the death transaction, a replacement generation, and a post-transaction idle clear', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:S', schema_version: SCHEMA_VERSION, identity: 'blood-angels-corpse', persona: 'astartes', tint: '#1' });
  await daemon.launch({ seat_id: 'somnium:N', schema_version: SCHEMA_VERSION, identity: 'sibling', persona: 'astartes', tint: '#2' });
  const corpseGeneration = await tmux.seatGeneration('somnium:S');
  await tmux.killSeat('somnium:S'); // remain-on-exit corpse: pane stays, dead

  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'somnium' });
  expect(result).toMatchObject({ ok: true, event: 'pane-died', page: 'somnium', reconstructed: true, reset_seats: ['somnium:S'] });

  // The exact per-seat death transaction, and nothing wider.
  const events = await store.readAll();
  expect(events.filter((e) => e.event_type === 'reg.retired').map((e) => e.entity_id)).toEqual(['blood-angels-corpse']);
  expect(events.filter((e) => e.event_type === 'reg.process_reaped').map((e) => e.entity_id)).toEqual(['somnium:S']);
  expect(events.filter((e) => e.event_type === 'reg.seat_cleared').map((e) => e.entity_id)).toEqual(['somnium:S']);
  expect(tmux.resetSeats()).toEqual(['somnium:S']);
  expect(tmux.rebuiltPages()).toEqual([]);
  const rows = await daemon.estateRows();
  expect(rows.find((row) => row.seat_id === 'somnium:N')).toMatchObject({ binding: 'bound', pane: 'live' });
  expect(rows.find((row) => row.seat_id === 'somnium:S')).toMatchObject({ binding: 'unbound', pane: 'live' });

  // The respawn minted a replacement generation; the corpse generation is gone.
  const replacementGeneration = await tmux.seatGeneration('somnium:S');
  expect(replacementGeneration).toBeDefined();
  expect(replacementGeneration).not.toBe(corpseGeneration);

  // The idle clear targeted exactly the replacement generation, and only after
  // the death transaction was durable.
  expect(tmux.idleScreenClears()).toEqual([{ seat_id: 'somnium:S', pane_generation: replacementGeneration! }]);
  const cleared = events.find((e) => e.event_type === 'estate.idle_screen_cleared');
  expect(cleared).toMatchObject({ entity_type: 'seat', entity_id: 'somnium:S' });
  expect(cleared!.payload).toMatchObject({ pane_generation: replacementGeneration });
  const completed = events.find((e) => e.event_type === 'estate.scoped_reset_completed')!;
  expect(cleared!.seq).toBeGreaterThan(completed.seq);
  expect(events.some((e) => e.event_type === 'estate.idle_screen_clear_failed')).toBe(false);
});

test('a clear that cannot prove the replacement idle shell is a named failure and never flips recovery green-to-red or red-to-green', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:SE', schema_version: SCHEMA_VERSION, identity: 'corpse', persona: 'astartes', tint: '#1' });
  await tmux.killSeat('somnium:SE');
  tmux.occupyAfterReset('somnium:SE', 'claude'); // a successor claims the pane before the clear

  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'somnium' });
  expect(result).toMatchObject({ ok: true, reconstructed: true, reset_seats: ['somnium:SE'] });

  // The clear refused rather than typing into the successor's UI; the refusal
  // is durable and named, and no cleared fact exists.
  expect(tmux.idleScreenClears()).toEqual([]);
  const events = await store.readAll();
  const failed = events.find((e) => e.event_type === 'estate.idle_screen_clear_failed');
  expect(failed).toMatchObject({ entity_type: 'seat', entity_id: 'somnium:SE' });
  expect(failed!.payload).toMatchObject({ reason: 'pane_not_idle' });
  expect(events.some((e) => e.event_type === 'estate.idle_screen_cleared')).toBe(false);
});

test('an already-canonical page records no clear at all — clearing is aftermath of a recovery, never a routine sweep', async () => {
  const { store, tmux, daemon } = await setup();
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-died', page: 'somnium' });
  expect(result).toMatchObject({ ok: true, reconstructed: false, reset_seats: [] });
  expect(tmux.idleScreenClears()).toEqual([]);
  const events = await store.readAll();
  expect(events.some((e) => e.event_type === 'estate.idle_screen_cleared' || e.event_type === 'estate.idle_screen_clear_failed')).toBe(false);
});
