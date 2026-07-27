import { expect, test } from 'bun:test';
import { SCHEMA_VERSION, type StaticLaunchHandshake } from '@terminus-os/contracts';
import { Daemon, type StaticLaunchRuntime } from '../src/core.ts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';

const RUNTIME: StaticLaunchRuntime = {
  agentWrapper: '/fleet/agent-wrapper',
  personaWorkspaceRoot: '/fleet/persona-workspaces',
  acknowledgeUrl: 'http://127.0.0.1:7781/ingress/static-launch',
};
const BUILD = { version: '0', git_sha: 'x', bun: 'y' };

function setup() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const daemon = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  return { store, tmux, daemon };
}

function handshakeFor(tmux: FakeTmux, seat: 'council:custodes' | 'council:fabricator-general'): StaticLaunchHandshake {
  const agent = tmux.staticAgent(seat);
  if (!agent) throw new Error(`missing fake static agent ${seat}`);
  return {
    launch_id: agent.launch.environment.TXD_STATIC_LAUNCH_ID!,
    token: agent.launch.environment.TXD_STATIC_LAUNCH_TOKEN!,
    instance_id: agent.launch.environment.TXD_STATIC_INSTANCE_ID!,
    seat_id: seat,
    engine: agent.engine,
    wrapper_pid: agent.wrapperPid,
    engine_pid: agent.enginePid,
    engine_executable: `/sanctioned/${agent.engine}`,
  };
}

async function acknowledgeBoth(daemon: Daemon, tmux: FakeTmux) {
  const custodes = handshakeFor(tmux, 'council:custodes');
  const fabricator = handshakeFor(tmux, 'council:fabricator-general');
  expect(await daemon.acknowledgeStaticLaunch(custodes)).toEqual({ ok: true, acknowledged: true, reason: null });
  expect(await daemon.acknowledgeStaticLaunch(fabricator)).toEqual({ ok: true, acknowledged: true, reason: null });
  return { custodes, fabricator };
}

test('provisions exactly Custodes and Fabricator-General, then binds only after physical acknowledgement', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();

  expect((await daemon.staticPersonaReadiness()).map((row) => row.state)).toEqual(['awaiting_ack', 'awaiting_ack']);
  expect(tmux.staticAgent('council:custodes')?.launch).toMatchObject({
    engine: 'claude',
    wrapper: RUNTIME.agentWrapper,
    workspace: `${RUNTIME.personaWorkspaceRoot}/custodes`,
  });
  expect(tmux.staticAgent('council:fabricator-general')?.launch).toMatchObject({
    engine: 'codex',
    workspace: `${RUNTIME.personaWorkspaceRoot}/fabricator-general`,
  });
  expect(tmux.staticAgent('council:pax')).toBeUndefined();
  expect(tmux.staticAgent('council:orchestrator')).toBeUndefined();
  expect(await tmux.seatTint('council:custodes')).toBeNull();
  expect(await tmux.seatTint('council:fabricator-general')).toBeNull();
  expect(await tmux.seatTint('council:pax')).toBeNull();
  expect(await tmux.seatTint('council:orchestrator')).toBeNull();

  const handshakes = await acknowledgeBoth(daemon, tmux);
  expect((await daemon.staticPersonaReadiness()).map((row) => row.state)).toEqual(['ready', 'ready']);
  expect(await tmux.seatTint('council:custodes')).toBe('#302800');
  expect(await tmux.seatTint('council:fabricator-general')).toBe('#300808');
  const bindings = (await daemon.estateRows()).filter((row) => row.binding === 'bound');
  expect(bindings.map((row) => row.seat_id)).toEqual(['council:custodes', 'council:fabricator-general']);
  expect((await daemon.health('k12-personal', BUILD)).ok).toBe(true);

  const duplicate = await daemon.acknowledgeStaticLaunch(handshakes.custodes);
  expect(duplicate).toEqual({ ok: false, acknowledged: false, reason: 'launch_absent_or_closed' });
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(2);
});

test('static tint application failure leaves the persona unbound and the pane untinted', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();
  tmux.failTintSeat('council:custodes');

  expect(await daemon.acknowledgeStaticLaunch(handshakeFor(tmux, 'council:custodes'))).toEqual({
    ok: false,
    acknowledged: false,
    reason: 'tint_attestation_failed',
  });
  expect(await tmux.seatTint('council:custodes')).toBeNull();
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'reg.bound' && event.entity_id === 'council:custodes',
  )).toHaveLength(0);
});

test('bound static tint drift is physically mismatched and makes health false', async () => {
  const { tmux, daemon } = setup();
  await daemon.constructEstate();
  await acknowledgeBoth(daemon, tmux);
  tmux.forceSeatTint('council:custodes', '#000000');

  expect((await daemon.staticPersonaReadiness()).find((row) =>
    row.seat_id === 'council:custodes',
  )).toMatchObject({
    state: 'mismatched',
    tint: '#302800',
    tint_attested: false,
  });
  expect((await daemon.health('k12-personal', BUILD)).ok).toBe(false);
});

test('bad tokens, tuple mismatches, stale replays, and physical mismatches never bind', async () => {
  {
    const { store, tmux, daemon } = setup();
    await daemon.constructEstate();
    const bad = { ...handshakeFor(tmux, 'council:custodes'), token: 'x'.repeat(32) };
    expect((await daemon.acknowledgeStaticLaunch(bad)).acknowledged).toBe(false);
    expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
    expect((await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_failed')).toHaveLength(0);
  }
  {
    const { store, tmux, daemon } = setup();
    await daemon.constructEstate();
    const wrong = { ...handshakeFor(tmux, 'council:custodes'), instance_id: crypto.randomUUID() };
    expect((await daemon.acknowledgeStaticLaunch(wrong)).reason).toBe('launch_attestation_failed');
    expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
    expect((await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_failed')).toHaveLength(1);
  }
  {
    const { store, tmux, daemon } = setup();
    await daemon.constructEstate();
    const wrong = { ...handshakeFor(tmux, 'council:fabricator-general'), engine_pid: 999_999 };
    expect((await daemon.acknowledgeStaticLaunch(wrong)).reason).toBe('launch_attestation_failed');
    expect((await store.readAll()).filter((event) => event.event_type === 'reg.bound')).toHaveLength(0);
  }
});

test('wrapper start failure records a typed failure and health stays false', async () => {
  const { store, tmux, daemon } = setup();
  tmux.failStaticAgentStart('council:custodes');
  await daemon.constructEstate();
  const failed = (await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]?.payload).toMatchObject({ reason: 'wrapper_start_failed', seat_id: 'council:custodes' });
  expect((await daemon.health('k12-personal', BUILD)).ok).toBe(false);
});

test('daemon restart closes pending reservations and relaunches fresh identities', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();
  const before = (await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_requested');
  const restarted = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  await restarted.constructEstate();
  const after = (await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_requested');
  expect(after).toHaveLength(before.length * 2);
  expect(after.slice(-2).map((event) => event.entity_id)).not.toEqual(before.map((event) => event.entity_id));
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'reg.static_launch_failed'
    && event.payload.reason === 'daemon_restarted_before_ack',
  )).toHaveLength(2);
  await acknowledgeBoth(restarted, tmux);
  expect((await restarted.health('k12-personal', BUILD)).ok).toBe(true);
});

test('a crash after request persistence but before wrapper start cannot orphan readiness', async () => {
  const { store, tmux } = setup();
  const launchId = crypto.randomUUID();
  await store.append({
    entity_type: 'instance',
    entity_id: launchId,
    event_type: 'reg.static_launch_requested',
    payload: {
      seat_id: 'council:custodes',
      instance_id: crypto.randomUUID(),
      engine: 'claude',
      persona: 'custodes',
      rank: 'overseer',
      commander: null,
      authority_principal: 'emperor',
      continuity_kind: 'daily_note',
      tint: '#302800',
      token_hash: 'a'.repeat(64),
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });

  const restarted = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  await restarted.constructEstate();

  expect((await store.readAll()).some((event) =>
    event.entity_id === launchId
    && event.event_type === 'reg.static_launch_failed'
    && event.payload.reason === 'daemon_restarted_before_ack',
  )).toBe(true);
  expect(tmux.staticAgent('council:custodes')).toBeDefined();
  expect(handshakeFor(tmux, 'council:custodes').launch_id).not.toBe(launchId);
});

test('Council reconstruction retires both instances and launches two fresh identities while civic seats stay unbound', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();
  const first = await acknowledgeBoth(daemon, tmux);

  const reset = await daemon.resetEstateScope({
    schema_version: SCHEMA_VERSION,
    force: true,
    scope: 'page',
    page: 'council',
  });
  expect(reset.ok).toBe(true);
  const secondCustodes = handshakeFor(tmux, 'council:custodes');
  const secondFabricator = handshakeFor(tmux, 'council:fabricator-general');
  expect(secondCustodes.instance_id).not.toBe(first.custodes.instance_id);
  expect(secondFabricator.instance_id).not.toBe(first.fabricator.instance_id);
  expect((await daemon.staticPersonaReadiness()).map((row) => row.state)).toEqual(['awaiting_ack', 'awaiting_ack']);
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'council:pax')?.binding).toBe('unbound');
  expect((await daemon.estateRows()).find((row) => row.seat_id === 'council:orchestrator')?.binding).toBe('unbound');

  await acknowledgeBoth(daemon, tmux);
  expect((await daemon.health('k12-personal', BUILD)).ok).toBe(true);
  const retired = (await store.readAll()).filter((event) =>
    event.event_type === 'reg.retired'
    && [first.custodes.instance_id, first.fabricator.instance_id].includes(event.entity_id),
  );
  expect(retired).toHaveLength(2);

  const requestsBeforeBoot = (await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_requested').length;
  const rebooted = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  await rebooted.constructEstate();
  expect((await store.readAll()).filter((event) => event.event_type === 'reg.static_launch_requested')).toHaveLength(requestsBeforeBoot);
});

test('boot resumes an interrupted Council reconstruction and retires both identities atomically', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();
  const first = await acknowledgeBoth(daemon, tmux);
  const boundGenerations = (await store.readAll())
    .filter((event) => event.event_type === 'reg.bound' && event.entity_id.startsWith('council:'))
    .map((event) => ({
      seat_id: event.entity_id,
      bound_seq: event.seq,
      pane_generation: event.payload.pane_generation,
    }));
  const rotationId = crypto.randomUUID();
  const seats = ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'];
  await store.append({
    entity_type: 'estate',
    entity_id: rotationId,
    event_type: 'estate.scoped_reset_requested',
    payload: {
      scope: 'page',
      seats,
      force: true,
      bound_seats: ['council:custodes', 'council:fabricator-general'],
      bound_generations: boundGenerations,
      foreground_workloads: [],
      trigger: 'pane-died',
    },
    provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
    occurred_at: new Date().toISOString(),
  });
  await tmux.rebuildPage('council');

  const restarted = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  await restarted.constructEstate();

  const events = await store.readAll();
  expect(events.filter((event) =>
    event.entity_id === rotationId && event.event_type === 'estate.scoped_reset_completed',
  )).toHaveLength(1);
  expect(events.filter((event) =>
    event.event_type === 'reg.retired'
    && [first.custodes.instance_id, first.fabricator.instance_id].includes(event.entity_id),
  )).toHaveLength(2);
  expect((await restarted.staticPersonaReadiness()).map((row) => row.state)).toEqual(['awaiting_ack', 'awaiting_ack']);
});

test('schema-7 untinted static bindings rotate through the typed Council reset on boot', async () => {
  const { store, tmux, daemon } = setup();
  await daemon.constructEstate();
  const first = await acknowledgeBoth(daemon, tmux);
  tmux.forceSeatTint('council:custodes', null);
  tmux.forceSeatTint('council:fabricator-general', null);
  const events = await store.readAll();
  const legacy = events.filter((event) => event.event_type === 'reg.bound');
  for (const event of legacy) event.payload.tint = null;

  const restarted = new Daemon(store, tmux, undefined, undefined, undefined, undefined, RUNTIME);
  await restarted.constructEstate();

  expect(tmux.rebuiltPages()).toContain('council');
  expect((await store.readAll()).filter((event) =>
    event.event_type === 'reg.retired'
    && [first.custodes.instance_id, first.fabricator.instance_id].includes(event.entity_id),
  )).toHaveLength(2);
  expect((await restarted.staticPersonaReadiness()).map((row) => row.state)).toEqual(['awaiting_ack', 'awaiting_ack']);
  await acknowledgeBoth(restarted, tmux);
  expect(await tmux.seatTint('council:custodes')).toBe('#302800');
  expect(await tmux.seatTint('council:fabricator-general')).toBe('#300808');
});
