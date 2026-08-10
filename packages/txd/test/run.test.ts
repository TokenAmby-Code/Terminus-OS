// tx run — one shell command against one pane, branching on txd's own
// event-sourced agent-presence truth: a REGISTERED binding takes the engine's
// `!` shell-escape branch, a bare declared seat takes the pane-shell branch,
// and everything else refuses loud and typed. Never a process-name sniff.
import { expect, test } from 'bun:test';
import { AGENT_SCHEMA_VERSION, SCHEMA_VERSION, type Agent, type PhysicalDeclaration } from '@terminus-os/contracts';
import { MemoryEventStore } from '../src/store.ts';
import { FakeTmux } from '../src/tmux.ts';
import { Daemon } from '../src/core.ts';
import { makeServer } from '../src/server.ts';
import type { TxdPublishedEventType } from '../src/events.ts';

const CONFIGURATION = { generation: 'estate-1', digest: 'c'.repeat(64) };
const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

function estate() {
  const store = new MemoryEventStore();
  const tmux = new FakeTmux();
  const runtime = {
    machine: 'k12-personal',
    configuration: CONFIGURATION,
    agentWrapper: '/fleet/agent-wrapper',
    perpetual: {},
    publish: async (_type: TxdPublishedEventType, _payload: Record<string, unknown>) => {},
  };
  const d = new Daemon(store, tmux, undefined, undefined, runtime);
  return { store, tmux, d };
}

let wrapperPid = 5100;

function declaration(seat: string, paneGeneration: string, agentId: string, persona: string, engine: 'claude' | 'codex', pid: number): PhysicalDeclaration {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: agentId,
    birth_generation: crypto.randomUUID(),
    pane_id: seat,
    pane_generation: paneGeneration,
    configuration: CONFIGURATION,
    engine,
    wrapper_pid: pid,
    persona,
    rank: 'astartes',
    tint: '#111111',
  };
}

function registeredAgent(seat: string, paneGeneration: string, decl: PhysicalDeclaration): Agent {
  return {
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: decl.agent_id,
    birth_generation: decl.birth_generation,
    registered_at: '2026-08-09T00:00:00.000Z',
    engine: decl.engine,
    launch: { argv: [], requested_cwd: '/workspace' },
    placement: {
      pane_id: seat,
      pane_generation: paneGeneration,
      machine: 'k12-personal',
      kind: 'local',
      wrapper_pid: decl.wrapper_pid,
      transport_witnesses: {},
    },
    configuration: CONFIGURATION,
    persona: {
      persona: decl.persona!,
      rank: decl.rank!,
      commander: null,
      tint: decl.tint!,
      voice: null,
      continuity_references: [],
      instruction_package: {
        digest: 'd'.repeat(64),
        sources: [],
        cache_path: `/personas/${decl.persona}/CLAUDE.md`,
      },
    },
    resources: [],
  };
}

/** The real registration chain: physical declaration, then registrationd's agent fact. */
async function register(d: Daemon, tmux: FakeTmux, seat: string, agentId: string, persona: string, engine: 'claude' | 'codex') {
  wrapperPid += 1;
  await tmux.createSeat(seat);
  tmux.bindWrapper(wrapperPid, seat);
  const paneGeneration = (await tmux.seatGeneration(seat))!;
  const decl = declaration(seat, paneGeneration, agentId, persona, engine, wrapperPid);
  await d.recordPhysicalDeclaration(decl);
  await d.activateRegisteredAgent(registeredAgent(seat, paneGeneration, decl));
}

test('a registered binding takes the agent branch: the engine shell escape is staged and the fact appended', async () => {
  const { store, tmux, d } = estate();
  const agentId = crypto.randomUUID();
  await register(d, tmux, 'council:custodes', agentId, 'custodes', 'claude');

  const result = await d.run({ schema_version: SCHEMA_VERSION, target: 'custodes', command: 'echo proof' });

  expect(result.mode).toBe('agent');
  if (result.mode !== 'agent') throw new Error('unreachable');
  expect(result.response).toMatchObject({
    ok: true, mode: 'agent', target: 'custodes', seat_id: 'council:custodes',
    agent_id: agentId, engine: 'claude', staged: true,
  });
  expect(tmux.agentComposerRuns()).toEqual([
    { seat_id: 'council:custodes', run_id: result.response.run_id, command: 'echo proof', engine: 'claude' },
  ]);
  expect(tmux.paneShellRuns()).toEqual([]);
  const injected = (await store.readAll()).filter((e) => e.event_type === 'act.agent_input_injected');
  expect(injected).toHaveLength(1);
  expect(injected[0]!.payload).toMatchObject({
    target_agent_id: agentId, seat_id: 'council:custodes',
    submit_verdict: 'staged', input_class: 'harness_shell', command: 'echo proof',
  });
});

test('a codex binding rides the same branch with its own engine named', async () => {
  const { tmux, d } = estate();
  await register(d, tmux, 'palace:N', crypto.randomUUID(), 'iron-hands', 'codex');

  const result = await d.run({ schema_version: SCHEMA_VERSION, target: 'palace:N', command: 'git status' });

  expect(result.mode).toBe('agent');
  expect(tmux.agentComposerRuns()[0]).toMatchObject({ seat_id: 'palace:N', command: 'git status', engine: 'codex' });
});

test('a bare declared seat executes in the pane shell and returns the harvest', async () => {
  const { tmux, d } = estate();
  await tmux.createSeat('palace:E');
  tmux.setShellRunResult('palace:E', { exit_code: 3, stdout: 'proof\n', stderr: 'warned\n', stdout_truncated: false, stderr_truncated: false });

  const result = await d.run({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'printf proof' });

  expect(result.mode).toBe('pane');
  if (result.mode !== 'pane') throw new Error('unreachable');
  const response = await result.pending;
  expect(response).toMatchObject({
    ok: true, mode: 'pane', seat_id: 'palace:E',
    exit_code: 3, stdout: 'proof\n', stderr: 'warned\n',
    stdout_truncated: false, stderr_truncated: false,
  });
  expect(tmux.paneShellRuns()).toEqual([
    { seat_id: 'palace:E', run_id: response.run_id, command: 'printf proof' },
  ]);
  expect(tmux.agentComposerRuns()).toEqual([]);
});

test('an identity nothing answers to refuses loud', async () => {
  const { d } = estate();
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'ghost-target', command: 'echo x' }))
    .rejects.toThrow('identity_absent: ghost-target');
});

test('a declared seat whose pane does not exist refuses as unresolved, never a silent no-op', async () => {
  const { d } = estate();
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'echo x' }))
    .rejects.toThrow('seat_unresolved: palace:E');
});

test('a persona worn by two registered agents is ambiguous', async () => {
  const { tmux, d } = estate();
  await register(d, tmux, 'palace:N', crypto.randomUUID(), 'black-shields', 'claude');
  await register(d, tmux, 'palace:S', crypto.randomUUID(), 'black-shields', 'claude');
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'black-shields', command: 'echo x' }))
    .rejects.toThrow('identity_ambiguous');
});

test('a foreground workload owns the pane: pane_busy names the command', async () => {
  const { tmux, d } = estate();
  await tmux.createSeat('palace:E');
  tmux.setCommand('palace:E', 'vim');
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'echo x' }))
    .rejects.toThrow('pane_busy: vim');
});

test('a binding mid-birth blocks the shell branch: the arriving agent owns that pane', async () => {
  const { tmux, d } = estate();
  wrapperPid += 1;
  await tmux.createSeat('palace:W');
  tmux.bindWrapper(wrapperPid, 'palace:W');
  const paneGeneration = (await tmux.seatGeneration('palace:W'))!;
  await d.recordPhysicalDeclaration(declaration('palace:W', paneGeneration, crypto.randomUUID(), 'scout', 'claude', wrapperPid));
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'palace:W', command: 'echo x' }))
    .rejects.toThrow('seat_binding_pending: palace:W');
});

test('a failed composer stage refuses loud and still records the attempt fact', async () => {
  const { store, tmux, d } = estate();
  await register(d, tmux, 'council:pax', crypto.randomUUID(), 'pax', 'claude');
  tmux.failAgentRun('council:pax');
  await expect(d.run({ schema_version: SCHEMA_VERSION, target: 'pax', command: 'echo x' }))
    .rejects.toThrow('run_not_staged: composer_corrupted');
  const injected = (await store.readAll()).filter((e) => e.event_type === 'act.agent_input_injected');
  expect(injected).toHaveLength(1);
  expect(injected[0]!.payload).toMatchObject({ submit_verdict: 'composer_corrupted', input_class: 'harness_shell' });
});

test('a pane replaced mid-run fails that run loud instead of hanging on a dead signal', async () => {
  const { tmux, d } = estate();
  await tmux.createSeat('palace:E');
  tmux.holdShellRun('palace:E');
  const result = await d.run({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'sleep forever' });
  if (result.mode !== 'pane') throw new Error('unreachable');
  const pending = result.pending;
  const reset = await d.resetEstateScope({ schema_version: SCHEMA_VERSION, force: true, scope: 'pane', pane: 'palace:E' });
  expect(reset.ok).toBe(true);
  await expect(pending).rejects.toThrow('pane_lost_mid_run: palace:E');
});

test('POST /agents/run refuses a multiline command at the membrane', async () => {
  const { d } = estate();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/run`, {
      method: 'POST',
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'echo a\necho b' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_run_request', field: '$.command' });
  } finally {
    srv.stop(true);
  }
});

test('POST /agents/run serves a typed refusal as a loud non-2xx', async () => {
  const { d } = estate();
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/run`, {
      method: 'POST',
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, target: 'ghost-target', command: 'echo x' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'run_refused', detail: 'identity_absent: ghost-target' });
  } finally {
    srv.stop(true);
  }
});

test('POST /agents/run completes a pane run as a deferred body carrying the harvest', async () => {
  const { tmux, d } = estate();
  await tmux.createSeat('palace:E');
  tmux.setShellRunResult('palace:E', { exit_code: 0, stdout: 'proof\n', stderr: '', stdout_truncated: false, stderr_truncated: false });
  const srv = makeServer({ bind: '127.0.0.1', port: 0, daemon: d, build, machine: 'test' });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/agents/run`, {
      method: 'POST',
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, target: 'palace:E', command: 'printf proof' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'pane', seat_id: 'palace:E', exit_code: 0, stdout: 'proof\n' });
  } finally {
    srv.stop(true);
  }
});
