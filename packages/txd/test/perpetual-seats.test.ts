// Perpetual seats — the ones the estate keeps staffed — are filled by a
// dispatch like every other agent. txd sees that a declared seat is empty and
// says so; registrationd mints the identity and dispatches it back. txd starting
// the engine itself is what produced council panes with no AGENT_ID in them,
// and there is now no code path that can do it: `SeatEngineLaunch.agentId` is
// required, so a launch with no identity does not typecheck.

import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, SCHEMA_VERSION } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };

/**
 * Builds the estate first, then hands back a published log that starts empty:
 * construction announces its own vacancies, and every assertion here is about
 * what a later sweep or close says, not about that first breath.
 */
async function setup(perpetual: Record<string, 'claude' | 'codex'>) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual,
    sshSeatTargets: { pages: {}, seats: {}, targets: [], targetFor: () => undefined },
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const d = new Daemon(store, tmux, undefined, undefined, runtime);
  await d.constructEstate();
  published.length = 0;
  return { store, tmux, published, runtime, d };
}

const vacancies = (published: Array<{ type: string; payload: Record<string, unknown> }>) =>
  published.filter((event) => event.type === 'agent.perpetual_seat_vacant');

const vacancy = (seat_id: string, engine: 'claude' | 'codex') => ({
  type: 'agent.perpetual_seat_vacant',
  payload: { schema_version: AGENT_SCHEMA_VERSION, machine: 'k12-personal', seat_id, engine },
});

test('an empty perpetual seat is announced vacant, not staffed', async () => {
  const { tmux, published, d } = await setup({
    'council:custodes': 'claude',
    'council:fabricator-general': 'codex',
  });

  await d.announceVacantPerpetualSeats();

  expect(vacancies(published)).toEqual([
    vacancy('council:custodes', 'claude'),
    vacancy('council:fabricator-general', 'codex'),
  ]);
  // Nothing was started here. The engine arrives with the dispatch or not at all.
  expect(tmux.seatEngine('council:custodes')).toBeUndefined();
  expect(tmux.seatEngine('council:fabricator-general')).toBeUndefined();
});

test('a perpetual seat already holding an agent is left alone', async () => {
  const { published, d } = await setup({ 'council:custodes': 'claude' });
  const launched = await d.launch({
    seat_id: 'council:custodes',
    schema_version: SCHEMA_VERSION,
    identity: 'ov-1',
    persona: 'custodes',
    rank: 'overseer',
    tint: '#302800',
  });
  expect(launched.ok).toBe(true);

  await d.announceVacantPerpetualSeats();

  expect(vacancies(published)).toEqual([]);
});

test('a perpetual seat whose pane is busy with a foreign process is left alone', async () => {
  const { tmux, published, d } = await setup({ 'council:custodes': 'claude' });
  tmux.setCommand('council:custodes', 'vim');

  await d.announceVacantPerpetualSeats();

  expect(vacancies(published)).toEqual([]);
});

test('a seat declared perpetual outside the estate is refused, never announced', async () => {
  const { published, runtime, d } = await setup({ 'council:custodes': 'claude' });
  runtime.perpetual = { 'mechanicus:W': 'claude' };

  await expect(d.announceVacantPerpetualSeats()).rejects.toThrow(/outside the canonical estate/);
  expect(vacancies(published)).toEqual([]);
});

test('closing the agent on a perpetual seat announces the vacancy instead of relaunching', async () => {
  const { store, tmux, published, d } = await setup({ 'council:custodes': 'claude' });
  const bind = async (seat: string, agent: string, rank: string, persona: string) => {
    const launched = await d.launch({
      seat_id: seat, schema_version: SCHEMA_VERSION, identity: agent, persona, rank, tint: '#302800',
    });
    if (!launched.ok) throw new Error(`bind failed: ${launched.reason}`);
    await store.append({
      entity_type: 'agent', entity_id: agent, event_type: 'reg.agent_registered',
      payload: { persona, rank, commander: null },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: '2026-08-01T00:00:00.000Z',
    });
  };
  await bind('council:custodes', 'cu-1', 'overseer', 'custodes');
  await bind('palace:W', 'ov-1', 'overseer', 'black-shields');
  published.length = 0;

  const closed = await d.close({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'ov-1',
    targets: ['council:custodes'],
    force: true,
  } as never);
  expect(closed.ok).toBe(true);

  expect(vacancies(published)).toEqual([vacancy('council:custodes', 'claude')]);
  // The reap kept the pane and returned the seat to the freelist; nothing was
  // started back into it from here.
  expect(tmux.seatEngine('council:custodes')).toBeUndefined();
});
