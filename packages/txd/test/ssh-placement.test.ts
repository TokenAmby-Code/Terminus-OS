// ssh seats: launch composition, the placement adapter, and seat-aware guards.
//
// An ssh seat is a k12-personal estate seat whose pane command is the LOCAL
// agent-wrapper owning an ssh transport into a remote one-pane tmux envelope.
// txd composes the launch environment (identity, launch nonce, target alias),
// remembers the composition against the pane generation, verifies the
// wrapper's transport claim at Door 1, and produces the first
// `kind: 'ssh'` placement. The wrapper never receives identity; the launch
// composition is the only identity channel, local and ssh births alike.

import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  AGENT_SCHEMA_VERSION,
  type DispatchRequested,
  type DispatchTarget,
  type PhysicalDeclaration,
  type Agent,
} from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { SSH_SEAT_TARGETS, sshSeatTarget, TXD_ESTATE, TXD_WINDOWS } from '../src/estate.ts';
import { envelopeSessionName } from '../src/envelopes.ts';

const DISPATCH_ID = '9f1b1f6a-5d4e-4a0f-9a2b-6c3d4e5f6071';
const AGENT_ID = '2ea2d049-0106-4957-8649-31f93bdc8c9a';
const BIRTH_GENERATION = '1cc2112c-9c38-45a1-839f-831c33a1096a';
const HOOK_REQUEST_ID = '5b7cf9a4-93b1-4c7f-9d9e-2f1a6b3c4d5e';
const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };
const SSH_SEAT = 'somnium:W';
const LOCAL_SEAT = 'palace:W';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup(remoteSessions: Record<string, string[]> = {}) {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  };
  const listEnvelopes = async (target: string): Promise<string[]> => remoteSessions[target] ?? [];
  const d = new Daemon(store, tmux, undefined, undefined, runtime as never, listEnvelopes);
  return { store, tmux, published, d };
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

type LaunchFacts = { launchNonce: string; paneGeneration: string };

async function dispatchTo(d: Daemon, tmux: FakeTmux, seatId: string): Promise<LaunchFacts> {
  await d.dispatch(request({ kind: 'seat', seat_id: seatId }));
  const launch = tmux.seatEngine(seatId);
  if (!launch?.launchNonce) throw new Error(`no launch composed for ${seatId}`);
  return { launchNonce: launch.launchNonce, paneGeneration: (await tmux.seatGeneration(seatId))! };
}

function sshHints(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ssh',
    target_machine: 'k12-work',
    launch_nonce: nonce,
    envelope_session: envelopeSessionName(SSH_SEAT, nonce),
    ...overrides,
  };
}

async function wrapperStart(
  d: Daemon,
  tmux: FakeTmux,
  seatId: string,
  wrapperPid: number,
  hints: Record<string, unknown>,
): Promise<{ attested: boolean; reason: string | null }> {
  tmux.bindWrapper(wrapperPid, seatId);
  return d.attestWrapperStart({
    hook_request_id: HOOK_REQUEST_ID,
    engine: 'claude',
    cwd: '/home/tokenamby',
    machine: 'k12-personal',
    wrapper_pid: wrapperPid,
    claimed_pane_id: seatId,
    argv: [],
    placement_hints: hints,
  });
}

function declaration(seatId: string, paneGeneration: string, wrapperPid: number): PhysicalDeclaration {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    pane_id: seatId,
    pane_generation: paneGeneration,
    configuration: CONFIGURATION,
    engine: 'claude',
    wrapper_pid: wrapperPid,
    persona: 'black-shields',
    rank: 'astartes',
    tint: '#111111',
  };
}

// ── The estate declaration ───────────────────────────────────────────────────

test('somnium seats are ssh seats targeting k12-work; every other seat is local', () => {
  for (const seat of TXD_WINDOWS.somnium) {
    expect(sshSeatTarget(seat)).toBe('k12-work');
  }
  for (const seat of TXD_ESTATE) {
    if ((TXD_WINDOWS.somnium as readonly string[]).includes(seat)) continue;
    expect(sshSeatTarget(seat)).toBeUndefined();
  }
  expect(Object.keys(SSH_SEAT_TARGETS).sort()).toEqual([...TXD_WINDOWS.somnium].sort());
});

// ── Launch composition ───────────────────────────────────────────────────────

test('dispatch to an ssh seat composes identity, nonce, and target into the launch', async () => {
  const { tmux, d, store } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: SSH_SEAT }));
  const launch = tmux.seatEngine(SSH_SEAT);
  expect(launch).toMatchObject({
    seatId: SSH_SEAT,
    engine: 'claude',
    wrapper: '/fleet/agent-wrapper',
    agentId: AGENT_ID,
    sshTarget: 'k12-work',
  });
  expect(launch!.launchNonce).toMatch(/^[0-9a-f-]{36}$/);
  const composed = (await store.readAll()).filter((e) => e.event_type === 'reg.launch_composed');
  expect(composed).toHaveLength(1);
  expect(composed[0]!.payload).toMatchObject({
    seat_id: SSH_SEAT,
    agent_id: AGENT_ID,
    launch_nonce: launch!.launchNonce,
    target_machine: 'k12-work',
    pane_generation: await tmux.seatGeneration(SSH_SEAT),
  });
});

test('dispatch to a local seat composes identity and nonce with no ssh target', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();
  await d.dispatch(request({ kind: 'seat', seat_id: LOCAL_SEAT }));
  const launch = tmux.seatEngine(LOCAL_SEAT);
  expect(launch!.agentId).toBe(AGENT_ID);
  expect(launch!.launchNonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(launch!.sshTarget).toBeUndefined();
});

test('a fresh dispatch to the same seat mints a fresh nonce', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();
  const first = await dispatchTo(d, tmux, SSH_SEAT);
  // The first launch never bound; the seat is still free, so a second
  // dispatch composes a new launch. Its nonce must differ — a new binding can
  // never attach a dead generation's envelope.
  await d.dispatch(request({ kind: 'seat', seat_id: SSH_SEAT }));
  const second = tmux.seatEngine(SSH_SEAT);
  expect(second!.launchNonce).not.toBe(first.launchNonce);
});

// ── The placement adapter: pane attestation ─────────────────────────────────

test('wrapper_start on a dispatched ssh seat attests kind ssh with the composed identity', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const { launchNonce } = await dispatchTo(d, tmux, SSH_SEAT);
  published.length = 0;
  const result = await wrapperStart(d, tmux, SSH_SEAT, 4101, sshHints(launchNonce));
  expect(result.attested).toBe(true);
  expect(published[0]).toMatchObject({
    type: 'agent.pane_attested',
    payload: { pane_id: SSH_SEAT, kind: 'ssh', agent_id: AGENT_ID },
  });
});

test('wrapper_start on a dispatched local seat attests kind local with the composed identity', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  await dispatchTo(d, tmux, LOCAL_SEAT);
  published.length = 0;
  const result = await wrapperStart(d, tmux, LOCAL_SEAT, 4101, { kind: 'local' });
  expect(result.attested).toBe(true);
  expect(published[0]).toMatchObject({
    type: 'agent.pane_attested',
    payload: { pane_id: LOCAL_SEAT, kind: 'local', agent_id: AGENT_ID },
  });
});

test('wrapper_start with no launch composition attests a null identity', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const result = await wrapperStart(d, tmux, LOCAL_SEAT, 4101, { kind: 'local' });
  expect(result.attested).toBe(true);
  expect(published[0]).toMatchObject({
    type: 'agent.pane_attested',
    payload: { pane_id: LOCAL_SEAT, kind: 'local', agent_id: null },
  });
});

// ── The placement adapter: Door 1 ───────────────────────────────────────────

async function sshBirth(
  d: Daemon,
  tmux: FakeTmux,
  hintsOverride?: Record<string, unknown> | null,
): Promise<{ facts: LaunchFacts; declare: () => Promise<void> }> {
  const facts = await dispatchTo(d, tmux, SSH_SEAT);
  const hints = hintsOverride === null
    ? { kind: 'local' }
    : sshHints(facts.launchNonce, hintsOverride ?? {});
  await wrapperStart(d, tmux, SSH_SEAT, 4101, hints);
  return {
    facts,
    declare: () => d.recordPhysicalDeclaration(declaration(SSH_SEAT, facts.paneGeneration, 4101)),
  };
}

test('Door 1 attests an ssh placement with transport witnesses', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const { facts, declare } = await sshBirth(d, tmux);
  published.length = 0;
  await declare();
  const attested = published.find((event) => event.type === 'agent.placement_attested');
  expect(attested).toBeDefined();
  expect(attested!.payload).toMatchObject({
    pane_id: SSH_SEAT,
    kind: 'ssh',
    machine: 'k12-work',
  });
  const witnesses = attested!.payload.transport_witnesses as Record<string, unknown>;
  expect(witnesses.target_machine).toBe('k12-work');
  expect(witnesses.launch_nonce_digest).toBe(sha256(facts.launchNonce));
  expect(witnesses.envelope_session).toBe(envelopeSessionName(SSH_SEAT, facts.launchNonce));
  expect(witnesses.wrapper_pid).toBe(4101);
});

test('Door 1 refuses a nonce that does not match the composed launch', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const { declare } = await sshBirth(d, tmux, { launch_nonce: crypto.randomUUID() });
  published.length = 0;
  await expect(declare()).rejects.toThrow('launch_nonce_contradicted');
  expect(published.find((event) => event.type === 'agent.placement_refused')?.payload).toMatchObject({
    reason: 'launch_nonce_contradicted',
    pane_id: SSH_SEAT,
  });
});

test('Door 1 refuses a transport claim naming the wrong machine', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const { declare } = await sshBirth(d, tmux, { target_machine: 'wsl' });
  published.length = 0;
  await expect(declare()).rejects.toThrow('placement_machine_incoherent');
  expect(published.find((event) => event.type === 'agent.placement_refused')?.payload).toMatchObject({
    reason: 'placement_machine_incoherent',
  });
});

test('Door 1 refuses a local claim on an ssh seat', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const { declare } = await sshBirth(d, tmux, null);
  published.length = 0;
  await expect(declare()).rejects.toThrow('placement_kind_incoherent');
  expect(published.find((event) => event.type === 'agent.placement_refused')?.payload).toMatchObject({
    reason: 'placement_kind_incoherent',
  });
});

test('Door 1 refuses an ssh claim on a local seat', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const facts = await dispatchTo(d, tmux, LOCAL_SEAT);
  await wrapperStart(d, tmux, LOCAL_SEAT, 4101, sshHints(facts.launchNonce));
  published.length = 0;
  await expect(
    d.recordPhysicalDeclaration(declaration(LOCAL_SEAT, facts.paneGeneration, 4101)),
  ).rejects.toThrow('placement_kind_incoherent');
});

test('a local birth with a local claim still attests kind local end to end', async () => {
  const { tmux, d, published } = setup();
  await d.constructEstate();
  const facts = await dispatchTo(d, tmux, LOCAL_SEAT);
  await wrapperStart(d, tmux, LOCAL_SEAT, 4101, { kind: 'local' });
  published.length = 0;
  await d.recordPhysicalDeclaration(declaration(LOCAL_SEAT, facts.paneGeneration, 4101));
  const attested = published.find((event) => event.type === 'agent.placement_attested');
  expect(attested!.payload).toMatchObject({ kind: 'local', machine: 'k12-personal' });
});

// ── Seat-aware registered-agent guards ──────────────────────────────────────

function registeredAgent(
  seatId: string,
  paneGeneration: string,
  placement: { kind: 'local' | 'ssh'; machine: string },
): Agent {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: AGENT_ID,
    birth_generation: BIRTH_GENERATION,
    registered_at: new Date().toISOString(),
    engine: 'claude',
    launch: { argv: [], requested_cwd: '/home/tokenamby' },
    placement: {
      pane_id: seatId,
      pane_generation: paneGeneration,
      machine: placement.machine,
      kind: placement.kind,
      wrapper_pid: 4101,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: {
      persona: 'black-shields',
      rank: 'astartes',
      commander: null,
      tint: '#111111',
      voice: null,
      continuity_references: [],
      instruction_package: {
        digest: 'd'.repeat(64),
        sources: [],
        cache_path: '/home/tokenamby/.local/share/token-fleet/agent-workspaces/black-shields/CLAUDE.md',
      },
    },
    resources: [],
  };
}

test('a registered ssh agent carrying the seat target machine activates', async () => {
  const { tmux, d, store } = setup();
  await d.constructEstate();
  const { facts, declare } = await sshBirth(d, tmux);
  await declare();
  await d.activateRegisteredAgent(registeredAgent(SSH_SEAT, facts.paneGeneration, { kind: 'ssh', machine: 'k12-work' }));
  const events = await store.readAll();
  expect(events.some((event) => event.event_type === 'reg.agent_registered')).toBe(true);
});

test('a registered agent claiming kind local on an ssh seat is a physical conflict', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();
  const { facts, declare } = await sshBirth(d, tmux);
  await declare();
  await expect(
    d.activateRegisteredAgent(registeredAgent(SSH_SEAT, facts.paneGeneration, { kind: 'local', machine: 'k12-personal' })),
  ).rejects.toThrow('registered_agent_physical_conflict');
});

test('a registered agent claiming kind ssh on a local seat is a physical conflict', async () => {
  const { tmux, d } = setup();
  await d.constructEstate();
  const facts = await dispatchTo(d, tmux, LOCAL_SEAT);
  await wrapperStart(d, tmux, LOCAL_SEAT, 4101, { kind: 'local' });
  await d.recordPhysicalDeclaration(declaration(LOCAL_SEAT, facts.paneGeneration, 4101));
  await expect(
    d.activateRegisteredAgent(registeredAgent(LOCAL_SEAT, facts.paneGeneration, { kind: 'ssh', machine: 'k12-work' })),
  ).rejects.toThrow('registered_agent_physical_conflict');
});

// ── Zombie envelopes ────────────────────────────────────────────────────────

test('the zombie report lists remote envelopes with no live binding and ignores foreign sessions', async () => {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async () => {},
  };
  let remote: string[] = [];
  const d = new Daemon(store, tmux, undefined, undefined, runtime as never, async () => remote);
  await d.constructEstate();
  const facts = await dispatchTo(d, tmux, SSH_SEAT);
  await wrapperStart(d, tmux, SSH_SEAT, 4101, sshHints(facts.launchNonce));
  await d.recordPhysicalDeclaration(declaration(SSH_SEAT, facts.paneGeneration, 4101));
  const live = envelopeSessionName(SSH_SEAT, facts.launchNonce);
  const zombie = envelopeSessionName('somnium:S', crypto.randomUUID());
  remote = [live, zombie, 'civic-dev-shell'];
  const report = await d.zombieEnvelopes();
  expect(report).toEqual([{ target: 'k12-work', session_name: zombie }]);
});

test('envelope session names carry the seat and the nonce with no tmux-hostile bytes', () => {
  const nonce = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const name = envelopeSessionName('somnium:NE', nonce);
  expect(name).toBe(`txd-somnium-NE-${nonce}`);
  expect(name).not.toMatch(/[:.\s]/);
});
