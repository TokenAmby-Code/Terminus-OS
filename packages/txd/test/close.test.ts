import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { buildProjections } from '../src/projections.ts';

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  return { store, tmux, d: new Daemon(store, tmux) };
}

const T = '2026-08-01T00:00:00.000Z';
const PROV = { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION } as const;

type BindOptions = { rank?: string; persona?: string; registered?: boolean };

async function bind(
  d: Daemon,
  store: MemoryEventStore,
  seat: string,
  agent: string,
  { rank = 'astartes', persona = 'black-shields', registered = true }: BindOptions = {},
): Promise<void> {
  const launched = await d.launch({
    seat_id: seat, schema_version: SCHEMA_VERSION, identity: agent, persona, rank, tint: '#111111',
  });
  if (!launched.ok) throw new Error(`test bind failed: ${launched.reason}`);
  if (registered) {
    await store.append({
      entity_type: 'agent', entity_id: agent, event_type: 'reg.agent_registered',
      payload: { persona, rank, commander: null }, provenance: PROV, occurred_at: T,
    });
  }
}

/** The registered overseer source every authorized request speaks as. */
async function overseer(d: Daemon, store: MemoryEventStore): Promise<string> {
  await bind(d, store, 'council:custodes', 'ov-1', { rank: 'overseer', persona: 'custodes' });
  return 'ov-1';
}

async function working(store: MemoryEventStore, agent: string): Promise<void> {
  await store.append({
    entity_type: 'agent', entity_id: agent, event_type: 'act.prompt_submitted',
    payload: {}, provenance: PROV, occurred_at: T,
  });
}

async function stopped(store: MemoryEventStore, agent: string): Promise<void> {
  await working(store, agent);
  await store.append({
    entity_type: 'agent', entity_id: agent, event_type: 'act.stop_reported',
    payload: {}, provenance: PROV, occurred_at: T,
  });
}

function req(extra: Record<string, unknown>) {
  return { schema_version: SCHEMA_VERSION, source_agent_id: 'ov-1', ...extra } as never;
}

// Rung 3: /close is the sanctioned remote-close verb. It REAPS the agent
// process, KEEPS the pane (respawned bare), and returns the seat to the
// freelist — retired + process_reaped + seat_cleared, atomic, per seat.

test('overseer closes an idle agent by seat id: retire chain, pane kept, seat freed', async () => {
  const { store, tmux, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  const res = await d.close(req({ targets: ['reservists:W'] }));
  expect(res).toMatchObject({ ok: true, closed_count: 1, refused_count: 0, reason: null });
  expect(res.verdicts).toEqual([
    { target: 'reservists:W', seat_id: 'reservists:W', agent_id: 'w-1', closed: true, reason: null },
  ]);

  const types = (await store.readAll()).map((e) => e.event_type);
  expect(types).toContain('reg.retired');
  expect(types).toContain('reg.process_reaped');
  expect(types).toContain('reg.seat_cleared');

  const p = buildProjections(await store.readAll());
  expect(p.currentBindings.map((b) => b.seat_id)).toEqual(['council:custodes']); // source untouched
  expect(p.freelist).toContainEqual({ seat_id: 'reservists:W', pane_state: 'live' });
  expect((await tmux.listSeats()).find((s) => s.seat_id === 'reservists:W')!.pane).toBe('live');
  expect(await tmux.seatTint('reservists:W')).toBeNull();
});

test('close resolves by agent id as well as seat id', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'somnium:NE', 'w-1');
  const res = await d.close(req({ targets: ['w-1'] }));
  expect(res.ok).toBe(true);
  expect(res.verdicts[0]).toMatchObject({ seat_id: 'somnium:NE', agent_id: 'w-1', closed: true });
});

test('an astartes source is refused and the refusal names the required rank', async () => {
  const { store, d } = setup();
  await bind(d, store, 'reservists:W', 'w-1');
  await bind(d, store, 'reservists:N', 'w-2');
  const before = await store.count();
  const res = await d.close({ schema_version: SCHEMA_VERSION, source_agent_id: 'w-1', targets: ['w-2'] } as never);
  expect(res).toMatchObject({ ok: false, closed_count: 0, verdicts: [] });
  expect(res.reason).toContain('not_authorized');
  expect(res.reason).toContain('overseer');
  expect(res.reason).toContain('astartes');
  expect(await store.count()).toBe(before);
});

test('an unregistered or unknown source is refused loud', async () => {
  const { store, d } = setup();
  await bind(d, store, 'reservists:W', 'w-1');
  await bind(d, store, 'reservists:S', 'ghost', { rank: 'overseer', registered: false });
  for (const source of ['ghost', 'never-born']) {
    const res = await d.close({ schema_version: SCHEMA_VERSION, source_agent_id: source, targets: ['w-1'] } as never);
    expect(res).toMatchObject({ ok: false, verdicts: [] });
    expect(res.reason).toContain('source_not_registered');
  }
});

test('palace:N is never closable — hard refusal by seat id and by agent id, force included', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'palace:N', 'emp-adjacent');
  for (const target of ['palace:N', 'emp-adjacent']) {
    const res = await d.close(req({ targets: [target], force: true }));
    expect(res.ok).toBe(false);
    expect(res.verdicts[0]).toMatchObject({ target, closed: false });
    expect(res.verdicts[0]!.reason).toContain('palace:N');
  }
  const p = buildProjections(await store.readAll());
  expect(p.currentBindings.map((b) => b.seat_id)).toContain('palace:N');
});

test('a mid-turn agent refuses gracefully; force overrides for a hung agent', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  await working(store, 'w-1');

  const refused = await d.close(req({ targets: ['w-1'] }));
  expect(refused.ok).toBe(false);
  expect(refused.verdicts[0]!.reason).toContain('mid_turn');
  expect(buildProjections(await store.readAll()).currentBindings.map((b) => b.agent_id)).toContain('w-1');

  const forced = await d.close(req({ targets: ['w-1'], force: true }));
  expect(forced.ok).toBe(true);
  expect(forced.verdicts[0]).toMatchObject({ closed: true, agent_id: 'w-1' });
});

test('a stopped agent closes without force', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  await stopped(store, 'w-1');
  const res = await d.close(req({ targets: ['w-1'] }));
  expect(res.ok).toBe(true);
});

test('close of a non-bound target refuses loud — never a silent no-op', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  const before = await store.count();
  const res = await d.close(req({ targets: ['reservists:W'] }));
  expect(res).toMatchObject({ ok: false, closed_count: 0, refused_count: 1 });
  expect(res.verdicts[0]!.reason).toContain('no_binding');
  expect(await store.count()).toBe(before);
});

test('bulk close: N explicit targets, N individual retirements, one invocation', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  await bind(d, store, 'reservists:S', 'w-2');
  const res = await d.close(req({ targets: ['w-1', 'reservists:S'] }));
  expect(res).toMatchObject({ ok: true, closed_count: 2, refused_count: 0 });

  const events = await store.readAll();
  const retired = events.filter((e) => e.event_type === 'reg.retired').map((e) => e.entity_id).sort();
  expect(retired).toEqual(['w-1', 'w-2']); // one retirement fact per agent
  const p = buildProjections(events);
  expect(p.freelist.map((f) => f.seat_id).sort()).toEqual(['reservists:S', 'reservists:W']);
});

test('bulk close is per-target independent: a refused sibling never blocks a close', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-idle');
  await bind(d, store, 'reservists:S', 'w-busy');
  await working(store, 'w-busy');
  const res = await d.close(req({ targets: ['w-busy', 'w-idle'] }));
  expect(res).toMatchObject({ ok: false, closed_count: 1, refused_count: 1 });
  expect(res.verdicts.find((v) => v.target === 'w-idle')).toMatchObject({ closed: true });
  expect(res.verdicts.find((v) => v.target === 'w-busy')!.reason).toContain('mid_turn');
  const bound = buildProjections(await store.readAll()).currentBindings.map((b) => b.agent_id);
  expect(bound).toContain('w-busy');
  expect(bound).not.toContain('w-idle');
});

test('duplicate targets resolving to one binding close once — one retire chain', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  const res = await d.close(req({ targets: ['reservists:W', 'w-1'] }));
  expect(res.closed_count).toBe(1);
  expect(res.verdicts.filter((v) => v.closed)).toHaveLength(1);
  const retired = (await store.readAll()).filter((e) => e.event_type === 'reg.retired');
  expect(retired).toHaveLength(1);
});

test('--page filter closes every closable agent on the page and nothing else', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-idle');
  await bind(d, store, 'reservists:S', 'w-stopped');
  await stopped(store, 'w-stopped');
  await bind(d, store, 'reservists:N', 'w-busy');
  await working(store, 'w-busy');
  await bind(d, store, 'somnium:W', 'other-page');

  const res = await d.close(req({ page: 'reservists' }));
  expect(res.ok).toBe(true);
  expect(res.verdicts.map((v) => v.agent_id).sort()).toEqual(['w-idle', 'w-stopped']);

  const bound = buildProjections(await store.readAll()).currentBindings.map((b) => b.agent_id);
  expect(bound).toContain('w-busy'); // mid-turn: not selected by a graceful filter
  expect(bound).toContain('other-page');
  expect(bound).toContain('ov-1');
});

test('--all-idle sweeps estate-wide but never selects an overseer, an unregistered binding, or palace:N', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  await bind(d, store, 'somnium:N', 'w-2');
  await stopped(store, 'w-2');
  await bind(d, store, 'somnium:S', 'w-busy');
  await working(store, 'w-busy');
  await bind(d, store, 'reservists:E', 'w-unreg', { registered: false });
  await bind(d, store, 'palace:N', 'emp-adjacent');
  await bind(d, store, 'council:pax', 'ov-2', { rank: 'overseer', persona: 'pax' });

  const res = await d.close(req({ all_idle: true }));
  expect(res.ok).toBe(true);
  expect(res.verdicts.map((v) => v.agent_id).sort()).toEqual(['w-1', 'w-2']);

  const bound = buildProjections(await store.readAll()).currentBindings.map((b) => b.agent_id).sort();
  expect(bound).toEqual(['emp-adjacent', 'ov-1', 'ov-2', 'w-busy', 'w-unreg']);
});

test('a filter matching nothing refuses loud — no_targets, no events', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  const before = await store.count();
  const res = await d.close(req({ all_idle: true }));
  expect(res).toMatchObject({ ok: false, verdicts: [] });
  expect(res.reason).toContain('no_targets');
  expect(await store.count()).toBe(before);
});

test('a failed reap refuses that target loud and writes NO retire chain for it', async () => {
  const { store, tmux, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-stuck');
  await bind(d, store, 'reservists:S', 'w-fine');
  tmux.failReapSeat('reservists:W');
  const res = await d.close(req({ targets: ['w-stuck', 'w-fine'] }));
  expect(res).toMatchObject({ ok: false, closed_count: 1, refused_count: 1 });
  expect(res.verdicts.find((v) => v.target === 'w-stuck')!.reason).toContain('reap_failed');
  const p = buildProjections(await store.readAll());
  expect(p.currentBindings.map((b) => b.agent_id)).toContain('w-stuck');
  expect(p.currentBindings.map((b) => b.agent_id)).not.toContain('w-fine');
});

test('a tint-clear failure prevents reap and preserves the current binding signal', async () => {
  const { store, tmux, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  tmux.failTintClearSeat('reservists:W');
  const before = await store.count();
  const res = await d.close(req({ targets: ['w-1'] }));
  expect(res.ok).toBe(false);
  expect(await tmux.seatTint('reservists:W')).toBe('#111111');
  expect(await store.count()).toBe(before);
});

test('schema mismatch refuses close loud', async () => {
  const { store, d } = setup();
  await overseer(d, store);
  await bind(d, store, 'reservists:W', 'w-1');
  const res = await d.close({ schema_version: 1099, source_agent_id: 'ov-1', targets: ['w-1'] } as never);
  expect(res).toMatchObject({ ok: false, verdicts: [] });
  expect(res.reason).toContain('schema_version_mismatch');
});
