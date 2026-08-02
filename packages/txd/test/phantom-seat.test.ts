import { expect, test } from 'bun:test';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { bindOverseerSource, closeRequest } from './close-fixture.ts';

// Lane: behavioral-pin (the gating lane).
//
// The defect these were written against: `tx estate show` reported 20 rows
// against an estate of 17 seats. `proof:bus`, `reservists:civic` and
// `reservists:token-os` appeared in every estate read, carried no binding, and
// had no tmux pane behind them. They are surviving `reg.pane_created` ledger
// facts whose panes are gone.
//
// The mechanism is that `paneBySeat` is only ever removed from by
// `reg.seat_decommissioned`. `reg.seat_cleared` clears the binding and leaves
// the pane axis untouched by design, and `reg.process_reaped` deliberately has
// no pane effect at all — so a seat that was reaped and cleared, or that was
// simply dropped from the TXD_ESTATE declaration, stays 'live' in the fold
// forever. Reconcile did not catch it because it iterated only (a) current
// bindings and (b) tmux-observed seats: a seat that is unbound in the fold AND
// absent from tmux was iterated by nothing.
//
// The fold is not wrong and is deliberately NOT changed here. `buildProjections`
// is a pure replay fold and its purity is load-bearing for replay determinism —
// teaching it to consult tmux would make a projection non-deterministic. The
// missing piece is the reconciliation pass that compares the fold against
// observed reality, which is exactly what reconcile is for.
//
// Refusing rather than merely reporting is deliberate. An estate read inflated
// with seats that do not exist is not a healthy estate, and the contradiction
// is closable: `reg.seat_decommissioned` both closes the flag and removes the
// row, so the flag names an action the operator can actually take.

function setup() {
  const tmux = new FakeTmux();
  const store = new MemoryEventStore();
  return { tmux, store, d: new Daemon(store, tmux) };
}

// The proof:bus shape: an ad-hoc seat launched through the door, reaped and
// cleared, whose pane then went away. Binding gone, pane fact surviving.
test('a cleared seat whose pane is gone is flagged as a phantom', async () => {
  const { tmux, store, d } = setup();
  await d.launch({
    seat_id: 'proof:bus', schema_version: 11, identity: 'i-1', persona: 'astartes', tint: '#101010',
  });
  await bindOverseerSource(d, store);
  await d.close(closeRequest(['proof:bus']));
  tmux.deleteOutOfBand('proof:bus');

  const rec = await d.reconcile();

  expect(rec.ok).toBe(false);
  expect(rec.p0).toBe(true);
  const flagged = rec.new_contradictions.find((c) => c.entity_id === 'proof:bus');
  expect(flagged).toBeDefined();
  expect(flagged!.kind).toBe('pane_absent');
  // Names the attestation that would actually resolve it.
  expect(flagged!.missing_attestation).toBe('seat_decommissioned');

  // A flag is written; no lifecycle event is synthesized on the seat's behalf.
  const types = (await store.readByEntity('proof:bus')).map((e) => e.event_type);
  expect(types).toContain('reg.contradiction_flagged');
  expect(types).not.toContain('reg.seat_decommissioned');
  expect(types).not.toContain('reg.teardown_started');
});

// The reservists:civic / reservists:token-os shape: a seat the estate
// declaration once stood and later dropped, with no decommission ever written.
test('a seat dropped from the declaration without a decommission is flagged', async () => {
  const { store, d } = setup();
  await store.append({
    entity_type: 'seat',
    entity_id: 'reservists:civic',
    event_type: 'reg.pane_created',
    payload: { pane_state: 'live' },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: 8 },
    occurred_at: new Date().toISOString(),
  });

  const rec = await d.reconcile();

  expect(rec.new_contradictions).toContainEqual(expect.objectContaining({
    entity_id: 'reservists:civic',
    kind: 'pane_absent',
  }));
  expect(rec.ok).toBe(false);
});

// The whole point of the defect: the estate read was inflated. Pin the pair the
// survey identified as the ready-made detector — rows[] is a pure fold that
// never consults tmux, tints[] does — so a regression shows up as the same
// disagreement that exposed this in the first place.
test('a phantom is exactly a row with no tint-readiness counterpart', async () => {
  const { tmux, store, d } = setup();
  await d.launch({
    seat_id: 'proof:bus', schema_version: 11, identity: 'i-1', persona: 'astartes', tint: '#101010',
  });
  await bindOverseerSource(d, store);
  await d.close(closeRequest(['proof:bus']));
  tmux.deleteOutOfBand('proof:bus');

  const rows = await d.estateRows();
  const tints = await d.tintReadiness();
  const phantoms = rows
    .map((row) => row.seat_id)
    .filter((seat) => seat !== null && !tints.some((tint) => tint.seat_id === seat));
  expect(phantoms).toEqual(['proof:bus']);

  // And reconcile must flag precisely that set — no more, no less.
  const rec = await d.reconcile();
  const flagged = rec.new_contradictions.filter((c) => c.kind === 'pane_absent').map((c) => c.entity_id);
  expect(flagged).toEqual(['proof:bus']);
});

// A healthy estate must stay green. The declared seats are all present in tmux,
// so nothing may be flagged — otherwise the check would make reconcile
// permanently red, which is the same defect inverted.
test('a fully-attested estate flags no phantom', async () => {
  const { d } = setup();
  await d.constructEstate();

  const rec = await d.reconcile();

  expect(rec.new_contradictions.filter((c) => c.kind === 'pane_absent')).toHaveLength(0);
});

// A seat whose pane is dead but still present in tmux is a DIFFERENT condition
// with its own existing flag. Absence and death must not be conflated: a dead
// pane is still observable and still reconcilable, a phantom is neither.
test('an observable dead pane is not reported as absent', async () => {
  const { tmux, d } = setup();
  await d.launch({
    seat_id: 'palace:W', schema_version: 11, identity: 'i-1', persona: 'salamander', tint: '#302800',
  });
  tmux.killOutOfBand('palace:W');

  const rec = await d.reconcile();

  expect(rec.new_contradictions.some((c) => c.kind === 'bound_pane_dead')).toBe(true);
  expect(rec.new_contradictions.some((c) => c.kind === 'pane_absent')).toBe(false);
});

// Same satiation rule as every other contradiction: flag once, stay open, do
// not re-emit on every reconcile pass.
test('a phantom is not double-flagged across reconcile passes', async () => {
  const { tmux, store, d } = setup();
  await d.launch({
    seat_id: 'proof:bus', schema_version: 11, identity: 'i-1', persona: 'astartes', tint: '#101010',
  });
  await bindOverseerSource(d, store);
  await d.close(closeRequest(['proof:bus']));
  tmux.deleteOutOfBand('proof:bus');

  const first = await d.reconcile();
  expect(first.new_contradictions.filter((c) => c.kind === 'pane_absent')).toHaveLength(1);

  const second = await d.reconcile();
  expect(second.new_contradictions.filter((c) => c.kind === 'pane_absent')).toHaveLength(0);
  expect(second.p0).toBe(true);
});
