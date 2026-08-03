// Dispatch seat resolution. A dispatch targets either a page — txd autofills a
// free seat — or one exact seat. Autofill never displaces a foreign foreground
// process; an explicitly named seat replaces whatever its pane is running,
// because naming the seat is the authorization and the CLI's in-place default
// resolves to the invoking pane, whose foreground is the invoker itself. Every
// refusal names the seat-level truth.

import { expect, test } from 'bun:test';
import {
  AGENT_SCHEMA_VERSION,
  type DispatchRequested,
  type DispatchTarget,
  type PhysicalDeclaration,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const DISPATCH_ID = '9f1b1f6a-5d4e-4a0f-9a2b-6c3d4e5f6071';
const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  return { store, tmux, published, d: new Daemon(store, tmux, undefined, undefined, runtime) };
}

function request(target: DispatchTarget): DispatchRequested {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    dispatch_id: DISPATCH_ID,
    agent_id: AGENT_ID,
    machine: 'k12-personal',
    target,
    engine: 'claude',
  };
}

async function bindSeat(d: Daemon, tmux: FakeTmux, seatId: string): Promise<void> {
  tmux.bindWrapper(4101, seatId);
  const declaration: PhysicalDeclaration = {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: seatId,
    pane_generation: (await tmux.seatGeneration(seatId))!,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: 4101,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
  await d.recordPhysicalDeclaration(declaration);
}

test('a page target autofills the first free seat in declared order', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'page', page: 'palace' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: 'agent.dispatch_attested',
    payload: { dispatch_id: DISPATCH_ID, seat_id: 'palace:W', engine: 'claude' },
  });
  expect(tmux.seatEngine('palace:W')).toMatchObject({
    seatId: 'palace:W',
    engine: 'claude',
    wrapper: '/fleet/agent-wrapper',
    agentId: AGENT_ID,
  });
  expect(tmux.seatEngine('palace:W')!.launchNonce).toMatch(/^[0-9a-f-]{36}$/);
});

test('a page target to an undeclared page is refused, not guessed', async () => {
  const { published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'page', page: 'mechanicus' }));
  expect(published).toEqual([{
    type: 'agent.dispatch_refused',
    payload: {
      schema_version: AGENT_SCHEMA_VERSION,
      dispatch_id: DISPATCH_ID,
      machine: 'k12-personal',
      target: { kind: 'page', page: 'mechanicus' },
      engine: 'claude',
      reason: 'page_absent',
      seats: [],
    },
  }]);
});

test('autofill skips a pane held by a foreign process and takes the next idle seat', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  tmux.setCommand('palace:W', 'sudo');
  await d.dispatch(request({ kind: 'page', page: 'palace' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: 'agent.dispatch_attested',
    payload: { seat_id: 'palace:N' },
  });
});

test('an exhausted page refuses with the seat-level truth for every candidate', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await bindSeat(d, tmux, 'palace:W');
  tmux.setCommand('palace:N', 'sudo');
  for (const seat of ['palace:S', 'palace:E']) {
    await tmux.startSeatEngine({
      seatId: seat,
      engine: 'claude',
      wrapper: '/fleet/agent-wrapper',
      agentId: AGENT_ID,
      launchNonce: crypto.randomUUID(),
    });
  }
  published.length = 0;
  await d.dispatch(request({ kind: 'page', page: 'palace' }));
  expect(published).toEqual([{
    type: 'agent.dispatch_refused',
    payload: {
      schema_version: AGENT_SCHEMA_VERSION,
      dispatch_id: DISPATCH_ID,
      machine: 'k12-personal',
      target: { kind: 'page', page: 'palace' },
      engine: 'claude',
      reason: 'no_free_seat',
      seats: [
        { seat_id: 'palace:W', state: 'bound' },
        { seat_id: 'palace:N', state: 'foreign_process' },
        { seat_id: 'palace:S', state: 'foreign_process' },
        { seat_id: 'palace:E', state: 'foreign_process' },
      ],
    },
  }]);
});

test('a seat target lands on exactly the named seat', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:N' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: 'agent.dispatch_attested',
    payload: { dispatch_id: DISPATCH_ID, seat_id: 'palace:N', engine: 'claude' },
  });
  expect(tmux.seatEngine('palace:N')).toMatchObject({ seatId: 'palace:N' });
  expect(tmux.seatEngine('palace:W')).toBeUndefined();
});

test('a seat target replaces a foreign foreground process — naming the seat is the authorization', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  tmux.setCommand('palace:N', 'sudo');
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:N' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: 'agent.dispatch_attested',
    payload: { seat_id: 'palace:N' },
  });
});

test('a seat target bound to a live agent refuses with the binding named', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await bindSeat(d, tmux, 'palace:N');
  published.length = 0;
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:N' }));
  expect(published).toEqual([{
    type: 'agent.dispatch_refused',
    payload: {
      schema_version: AGENT_SCHEMA_VERSION,
      dispatch_id: DISPATCH_ID,
      machine: 'k12-personal',
      target: { kind: 'seat', seat_id: 'palace:N' },
      engine: 'claude',
      reason: 'seat_bound',
      seats: [{ seat_id: 'palace:N', state: 'bound' }],
    },
  }]);
});

test('a seat target outside the declared estate is refused, not guessed', async () => {
  const { published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: 'mechanicus:W' }));
  expect(published).toEqual([{
    type: 'agent.dispatch_refused',
    payload: {
      schema_version: AGENT_SCHEMA_VERSION,
      dispatch_id: DISPATCH_ID,
      machine: 'k12-personal',
      target: { kind: 'seat', seat_id: 'mechanicus:W' },
      engine: 'claude',
      reason: 'seat_absent',
      seats: [],
    },
  }]);
});

test('a seat target whose engine start fails refuses seat_start_failed', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  tmux.failSeatEngineStart('palace:N');
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:N' }));
  expect(published).toMatchObject([{
    type: 'agent.dispatch_refused',
    payload: { reason: 'seat_start_failed', target: { kind: 'seat', seat_id: 'palace:N' } },
  }]);
});

test('the orders a dispatch carries reach the launch composition verbatim', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  // Backticks, a blank line and a `$` — the shapes a real brief is made of,
  // and the ones a second quoting scheme would eat.
  const orders = 'Worker E.\n\nRun `rg dispatch` and read $PANE_ID.\n';
  await d.dispatch({ ...request({ kind: 'seat', seat_id: 'palace:N' }), prompt: orders });
  expect(published).toMatchObject([{ type: 'agent.dispatch_attested' }]);
  expect(tmux.seatEngine('palace:N')!.prompt).toBe(orders);
});

test('a bodiless dispatch composes a launch with no orders at all', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:N' }));
  expect(tmux.seatEngine('palace:N')!.prompt).toBeUndefined();
});
