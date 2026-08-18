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
import { resolveSshSeatTargets } from '../src/config.ts';
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
    sshSeatTargets: resolveSshSeatTargets({
      pages: { somnium: 'k12-work', somnium_fleet: 'k12-work' },
      seats: {},
    }),
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

test('a composed birth owns its freelist seat before the wrapper becomes observable', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'page', page: 'palace' }));

  // The wrapper has not become observable yet: tmux still reports the bare
  // shell. The durable launch composition must nevertheless keep a second
  // dispatch from silently replacing the first birth.
  tmux.setCommand('palace:W', 'bash');
  await d.dispatch({
    ...request({ kind: 'page', page: 'palace' }),
    dispatch_id: '8e0a0e2e-bae2-4eca-a666-5532509228d1',
    agent_id: 'd0debb42-d54f-434f-aeb4-345e6b54df91',
  });

  expect(published).toMatchObject([
    { type: 'agent.dispatch_attested', payload: { seat_id: 'palace:W' } },
    { type: 'agent.dispatch_attested', payload: { seat_id: 'palace:N' } },
  ]);
  expect(tmux.seatEngine('palace:W')?.agentId).toBe(AGENT_ID);
  expect(tmux.seatEngine('palace:N')?.agentId).toBe('d0debb42-d54f-434f-aeb4-345e6b54df91');
});

test('a named seat with a composed birth refuses loud while registration is pending', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:W' }));
  tmux.setCommand('palace:W', 'bash');
  published.length = 0;

  await d.dispatch({
    ...request({ kind: 'seat', seat_id: 'palace:W' }),
    dispatch_id: '8e0a0e2e-bae2-4eca-a666-5532509228d1',
    agent_id: 'd0debb42-d54f-434f-aeb4-345e6b54df91',
  });

  expect(published).toEqual([{
    type: 'agent.dispatch_refused',
    payload: {
      schema_version: AGENT_SCHEMA_VERSION,
      dispatch_id: '8e0a0e2e-bae2-4eca-a666-5532509228d1',
      machine: 'k12-personal',
      target: { kind: 'seat', seat_id: 'palace:W' },
      engine: 'claude',
      reason: 'seat_launching',
      seats: [{ seat_id: 'palace:W', state: 'launching' }],
    },
  }]);
});

test('a scoped reset releases an unbound composed birth for redispatch', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:W' }));

  expect((await d.resetEstateScope({
    schema_version: 12,
    force: true,
    scope: 'pane',
    pane: 'palace:W',
  })).ok).toBe(true);
  published.length = 0;
  await d.dispatch({
    ...request({ kind: 'seat', seat_id: 'palace:W' }),
    dispatch_id: '8e0a0e2e-bae2-4eca-a666-5532509228d1',
    agent_id: 'd0debb42-d54f-434f-aeb4-345e6b54df91',
  });

  expect(published).toMatchObject([{
    type: 'agent.dispatch_attested',
    payload: { seat_id: 'palace:W' },
  }]);
  expect(tmux.seatEngine('palace:W')?.agentId).toBe('d0debb42-d54f-434f-aeb4-345e6b54df91');
});

test('the mechanicus pool mints a fresh stack pane directly', async () => {
  const { store, tmux, published, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'page', page: 'mechanicus' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ type: 'agent.dispatch_attested' });
  const seatId = String(published[0]!.payload.seat_id);
  expect(seatId).toMatch(/^mechanicus:[0-9a-f-]{36}$/);
  expect(tmux.seatEngine(seatId)?.agentId).toBe(AGENT_ID);
  expect((await store.readAll()).filter((event) => event.entity_id === seatId).map((event) => event.event_type)).toEqual([
    'reg.pane_created',
    'reg.launch_composed',
  ]);
});

test('a minted stack pane is abandoned when its engine cannot start', async () => {
  class FailingStackTmux extends FakeTmux {
    override async startSeatEngine(launch: Parameters<FakeTmux['startSeatEngine']>[0]): Promise<boolean> {
      if (launch.seatId.startsWith('mechanicus:')) return false;
      return super.startSeatEngine(launch);
    }
  }
  const store = new MemoryEventStore();
  const tmux = new FailingStackTmux();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const d = new Daemon(store, tmux, undefined, undefined, {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    sshSeatTargets: resolveSshSeatTargets({
      pages: { somnium: 'k12-work', somnium_fleet: 'k12-work' },
      seats: {},
    }),
    publish: async (type: TxdPublishedEventType, payload: Record<string, unknown>) => { published.push({ type, payload }); },
  });
  await d.constructEstate();

  await d.dispatch(request({ kind: 'page', page: 'mechanicus' }));

  expect(published).toMatchObject([{ type: 'agent.dispatch_refused', payload: { reason: 'seat_start_failed' } }]);
  const dynamic = (await store.readAll()).filter((event) => event.entity_id.startsWith('mechanicus:')
    && event.entity_id !== 'mechanicus:new');
  expect(dynamic.map((event) => event.event_type)).toEqual(['reg.pane_created', 'reg.seat_abandoned']);
  expect((await tmux.listSeats()).find((seat) => seat.seat_id === dynamic[0]!.entity_id)?.pane).toBe('dead');
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

test('an exhausted palace falls through and mints a registered-identity stack pane', async () => {
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
  await d.dispatch(request({ kind: 'page', page: 'palace', stack_page: 'palace_fleet' }));
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: 'agent.dispatch_attested',
    payload: { dispatch_id: DISPATCH_ID, engine: 'claude' },
  });
  const seatId = String(published[0]!.payload.seat_id);
  expect(seatId).toMatch(/^palace_fleet:[0-9a-f-]{36}$/);
  expect(tmux.seatEngine(seatId)).toMatchObject({
    seatId,
    agentId: AGENT_ID,
    wrapper: '/fleet/agent-wrapper',
  });
});

test('a named palace seat falls through only when every declared palace seat is full', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  await bindSeat(d, tmux, 'palace:W');
  for (const seat of ['palace:N', 'palace:S', 'palace:E']) tmux.setCommand(seat, 'sudo');
  published.length = 0;

  await d.dispatch(request({ kind: 'seat', seat_id: 'palace:W', stack_page: 'palace_fleet' }));

  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ type: 'agent.dispatch_attested' });
  const seatId = String(published[0]!.payload.seat_id);
  expect(seatId).toMatch(/^palace_fleet:[0-9a-f-]{36}$/);
  expect(tmux.seatEngine(seatId)?.agentId).toBe(AGENT_ID);
});

test('somnium overflow reuses the remote wrapper placement per pane', async () => {
  const { tmux, published, d } = setup();
  await d.constructEstate();
  for (const seat of ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE']) {
    tmux.setCommand(seat, 'ssh');
  }
  await d.dispatch(request({ kind: 'page', page: 'somnium', stack_page: 'somnium_fleet' }));
  const seatId = String(published[0]!.payload.seat_id);
  expect(tmux.seatEngine(seatId)).toMatchObject({ seatId, sshTarget: 'k12-work' });
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
