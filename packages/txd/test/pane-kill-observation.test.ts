// Kill-time pane observation — behavioral-pin lane.
//
// A raw `tmux kill-pane` fires neither `pane-died` nor `pane-exited` (tmux
// 3.6: only the command hook `after-kill-pane` fires, and its format context
// is the ACTIVE window, not the window that lost the pane). The kill-time
// event therefore carries no page: txd sweeps the whole estate, retires
// exactly the seats it observes faulted, and never widens a single death to
// a page rebuild while any tagged pane on that page survives.

import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { Daemon } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { TXD_WINDOWS } from '../src/estate.ts';

async function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux);
  await daemon.constructEstate();
  return { store, tmux, daemon };
}

test('a page-less pane-killed event finds the one killed seat anywhere in the estate and retires it alone', async () => {
  const { store, tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:E', schema_version: SCHEMA_VERSION, identity: 'east', persona: 'astartes', tint: '#1' });
  await daemon.launch({ seat_id: 'palace:W', schema_version: SCHEMA_VERSION, identity: 'west', persona: 'astartes', tint: '#2' });
  tmux.deleteOutOfBand('palace:E');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-killed' });
  expect(result).toMatchObject({ ok: true, event: 'pane-killed', page: null, reconstructed: true, reset_seats: ['palace:E'] });
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:E']);
  const rows = await daemon.estateRows();
  expect(rows.find((row) => row.seat_id === 'palace:W')).toMatchObject({ binding: 'bound', pane: 'live' });
  expect(rows.find((row) => row.seat_id === 'palace:E')).toMatchObject({ binding: 'unbound', pane: 'live' });
  const events = await store.readAll();
  expect(events.filter((event) => event.event_type === 'reg.retired').map((event) => event.entity_id)).toEqual(['east']);
  const requested = events.findLast((event) => event.event_type === 'estate.scoped_reset_requested')!;
  expect(requested.payload).toMatchObject({ scope: 'pane', seats: ['palace:E'], trigger: 'pane-killed' });
  expect(requested.provenance).toMatchObject({ source: 'observer' });
});

test('kills across two pages in one sweep each retire alone and no page is rebuilt', async () => {
  const { tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'somnium:N', schema_version: SCHEMA_VERSION, identity: 'n', persona: 'astartes', tint: '#1' });
  tmux.deleteOutOfBand('palace:S');
  tmux.deleteOutOfBand('somnium:NE');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-killed' });
  expect(result.ok).toBe(true);
  expect([...result.reset_seats].sort()).toEqual(['palace:S', 'somnium:NE']);
  expect(tmux.rebuiltPages()).toEqual([]);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'somnium:N')).toMatchObject({ binding: 'bound', pane: 'live' });
});

test('a sweep over a canonical estate answers already-canonical without touching a pane', async () => {
  const { tmux, daemon } = await setup();
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-killed' });
  expect(result).toMatchObject({ ok: true, page: null, reconstructed: false, reset_seats: [], reason: 'estate_already_canonical' });
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual([]);
});

test('a sweep also retires remain-on-exit corpses so the kill door subsumes process death', async () => {
  const { tmux, daemon } = await setup();
  await tmux.killSeat('palace:S');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-killed' });
  expect(result).toMatchObject({ ok: true, reconstructed: true, reset_seats: ['palace:S'] });
  expect(tmux.rebuiltPages()).toEqual([]);
});

test('only a page with no tagged pane left earns the border-total rebuild', async () => {
  const { tmux, daemon } = await setup();
  for (const seat of TXD_WINDOWS.palace) tmux.deleteOutOfBand(seat);
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-killed' });
  expect(result.ok).toBe(true);
  expect(tmux.rebuiltPages()).toEqual(['palace']);
  expect([...result.reset_seats].sort()).toEqual([...TXD_WINDOWS.palace].sort());
});

test('a live observation with one missing pane and live siblings repairs the seat and never rebuilds the page', async () => {
  const { tmux, daemon } = await setup();
  await daemon.launch({ seat_id: 'palace:W', schema_version: SCHEMA_VERSION, identity: 'west', persona: 'astartes', tint: '#1' });
  tmux.deleteOutOfBand('palace:E');
  const result = await daemon.handleTmuxLifecycleEvent({ schema_version: SCHEMA_VERSION, event: 'pane-exited', page: 'palace' });
  expect(result).toMatchObject({ ok: true, page: 'palace', reconstructed: true, reset_seats: ['palace:E'] });
  expect(tmux.rebuiltPages()).toEqual([]);
  expect(tmux.resetSeats()).toEqual(['palace:E']);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'palace:W')).toMatchObject({ binding: 'bound', pane: 'live' });
});

test('the fake control plane repairs a deleted seat in place while the window survives', async () => {
  const tmux = new FakeTmux();
  const daemon = new Daemon(new MemoryEventStore(), tmux);
  await daemon.constructEstate();
  tmux.deleteOutOfBand('somnium:SE');
  expect(await tmux.resetSeat('somnium:SE')).toBeTruthy();
  expect(tmux.estateShape().windows.somnium).toEqual([...TXD_WINDOWS.somnium]);
  expect((await tmux.listSeats()).find((seat) => seat.seat_id === 'somnium:SE')).toMatchObject({ pane: 'live' });
});

test('the fake control plane refuses to repair a seat whose window is gone', async () => {
  const tmux = new FakeTmux();
  const daemon = new Daemon(new MemoryEventStore(), tmux);
  await daemon.constructEstate();
  for (const seat of TXD_WINDOWS.palace) tmux.deleteOutOfBand(seat);
  expect(await tmux.resetSeat('palace:E')).toBeNull();
});
