import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';
import { createTxdObservationClient } from '../src/observation.ts';

const testTimezone = async () => 'America/Phoenix';

function harness(response: unknown = { ok: true }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, ...(body === undefined ? {} : { body }) }); return response; },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    timezone: testTimezone,
    observation: {
      health: async () => response as never,
      inspect: async () => response as never,
    },
  };
  return { deps, stdout, stderr, calls };
}

test('health, inspect, and version use the STC observation client', async () => {
  const calls: string[] = [];
  const observation = {
    health: async () => { calls.push('health'); return { ok: true }; },
    inspect: async () => { calls.push('inspect'); return { holdings: [] }; },
  } as never;
  const version = () => ({ service: 'txd', daemon: 'txd', cli: 'tx', version: '0.1.0', stc_version: '1.3.0' });
  for (const operation of ['health', 'inspect', 'version']) {
    const h = harness();
    expect(await runCli([operation], { ...h.deps, observation, version })).toBe(0);
  }
  expect(calls).toEqual(['health', 'inspect']);
});

test('inspect accepts the current STC envelope through an additive funnel mouth', async () => {
  const probe = {
    name: 'postgres',
    rung: 'dependency' as const,
    state: 'ready' as const,
    detail: '',
    observed_at: '2026-08-30T15:30:00.000Z',
    elapsed_ms: 1,
    deadline_ms: 300_000,
    deadline_derived_from: 'fleet stop floor',
    caveats: ['read-only SELECT'],
    evidence: { select_1: 1 },
  };
  const envelope = {
    identity: { service: 'txd', daemon: 'txd', cli: 'tx' },
    version: '0.1.0',
    stc_version: '1.5.1',
    machine: 'k12-personal',
    probes: [probe],
    holdings: [],
    observation_ring: {
      capacity_per_probe: 4,
      capacity_derived_from: 'bounded retained evidence',
      probes: [{ name: 'postgres', failure_onset_at: null, readings: [probe] }],
    },
    additive_envelope_field: { introduced_after_this_client: true },
  };
  const h = harness();
  const observation = createTxdObservationClient({
    baseUrl: 'http://127.0.0.1:7781',
    fetch: async () => new Response(JSON.stringify(envelope), { status: 200 }),
  });
  expect(await runCli(['inspect'], { ...h.deps, observation })).toBe(0);
  expect(h.stderr).toEqual([]);
  const rendered = JSON.parse(h.stdout[0]!);
  expect(Object.keys(rendered).sort()).toEqual([
    'holdings', 'identity', 'machine', 'observation_ring', 'probes', 'stc_version', 'version',
  ]);
  expect(rendered.observation_ring.probes[0].name).toBe('postgres');
});

test('the shared router supports nested subcommands', async () => {
  const h = harness();
  expect(await runCli(['estate', 'missing'], h.deps)).toBe(2);
  expect(h.stderr[0]).toContain('unknown command: estate missing');
});

test('help is deterministic and lists extension points', async () => {
  const h = harness();
  expect(await runCli([], h.deps)).toBe(0);
  expect(h.stdout.join('\n')).toContain('tx health');
  expect(h.stdout.join('\n')).toContain('command=<name>|skill=<name> [-- args]');
  expect(h.stdout.join('\n')).toContain('caller supplies no /, $, or engine flag');
  expect(h.stdout.join('\n')).toContain('tx inspect hooks');
});

test('journal dispose sends one exact event sequence, required reason, and actor identity', async () => {
  const prior = process.env.AGENT_ID;
  process.env.AGENT_ID = 'custodes-worker';
  const h = harness({ ok: true, event_seq: 417, disposition: 'actor=custodes-worker; reason=invalid v8 backfill conflict' });
  try {
    expect(await runCli([
      'journal', 'dispose', '417', '--reason', 'invalid v8 backfill conflict',
    ], h.deps)).toBe(0);
    expect(h.calls).toEqual([{
      method: 'POST',
      path: '/ctl/journal/poison/dispose',
      body: {
        schema_version: 13,
        source_agent_id: 'custodes-worker',
        event_seq: '417',
        reason: 'invalid v8 backfill conflict',
      },
    }]);
  } finally {
    if (prior === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prior;
  }
});

test('journal dispose preserves the full PostgreSQL bigint event sequence over JSON', async () => {
  const prior = process.env.AGENT_ID;
  process.env.AGENT_ID = 'custodes-worker';
  const h = harness({ ok: false, error: 'journal_poison_absent', event_seq: '9223372036854775807' });
  try {
    expect(await runCli([
      'journal', 'dispose', '9223372036854775807', '--reason', 'nonexistent-control',
    ], h.deps)).toBe(0);
    expect(h.calls[0]?.body).toMatchObject({ event_seq: '9223372036854775807' });
  } finally {
    if (prior === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prior;
  }
});

test('journal dispose has no bulk shape and refuses a missing reason before transport', async () => {
  const h = harness();
  expect(await runCli(['journal', 'dispose', '417'], h.deps)).toBe(1);
  expect(await runCli(['journal', 'dispose', '*', '--reason', 'anything'], h.deps)).toBe(1);
  expect(await runCli(['journal', 'dispose', '417', '418', '--reason', 'anything'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});

test('inspect hooks returns bounded typed journal diagnostics', async () => {
  const h = harness({
    ok: true,
    schema_version: 11,
    source: 'systemd-journal',
    identifier: 'txd-tmux-hook',
    diagnostics: [{ recorded_at: '2026-08-17T17:00:00.000Z', priority: 3, message: 'Unable to connect' }],
  });
  expect(await runCli(['inspect', 'hooks', '--limit', '7'], h.deps)).toBe(0);
  expect(h.calls).toEqual([{ method: 'GET', path: '/tmux/read/diagnostics/hooks?limit=7' }]);
  expect(JSON.parse(h.stdout[0]!)).toEqual({
    ok: true,
    schema_version: 11,
    source: 'systemd-journal',
    identifier: 'txd-tmux-hook',
    diagnostics: [{ recorded_at: '2026-08-17 10:00:00 MST', priority: 3, message: 'Unable to connect' }],
  });
});

test('inspect hooks rejects unbounded and malformed limits', async () => {
  const h = harness();
  for (const value of ['0', '1001', 'wat']) {
    expect(await runCli(['inspect', 'hooks', '--limit', value], h.deps)).toBe(1);
  }
  expect(h.calls).toEqual([]);
});

test('raw tmux identifiers are rejected before CLI output', async () => {
  const h = harness({ ok: true, pane: '%12' });
  expect(await runCli(['health'], h.deps)).toBe(1);
  expect(h.stdout).toEqual([]);
  expect(h.stderr[0]).toContain('raw tmux identifier');
});

test('mode enter sends the semantic preplan transition contract', async () => {
  const h = harness({ schema_version: 13, verified: true });
  expect(await runCli([
    'mode', 'enter', '--target', 'council:custodes', '--trigger', 'preplan',
  ], h.deps)).toBe(0);
  expect(h.calls).toEqual([{
    method: 'POST',
    path: '/agents/mode',
    body: {
      schema_version: 13,
      target: 'council:custodes',
      intent: 'enter_plan',
      trigger: 'preplan',
    },
  }]);
});

test('mode approve sends the plan-approval intent and defaults to an operator trigger', async () => {
  const h = harness({ schema_version: 13, verified: true });
  expect(await runCli(['mode', 'approve', '--target', 'council:custodes'], h.deps)).toBe(0);
  expect(h.calls).toEqual([{
    method: 'POST',
    path: '/agents/mode',
    body: {
      schema_version: 13,
      target: 'council:custodes',
      intent: 'approve_plan',
      trigger: 'operator',
    },
  }]);
});

test('mode toggle defaults to an operator transition', async () => {
  const h = harness({ schema_version: 13, verified: true });
  expect(await runCli(['mode', 'toggle', '--target', 'council:custodes'], h.deps)).toBe(0);
  expect(h.calls[0]).toEqual({
    method: 'POST',
    path: '/agents/mode',
    body: {
      schema_version: 13,
      target: 'council:custodes',
      intent: 'toggle_plan',
      trigger: 'operator',
    },
  });
});

test('invalid mode arguments never reach txd', async () => {
  const h = harness();
  expect(await runCli(['mode', 'enter', '--target', 'council:custodes', '--trigger', 'operator'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
  expect(h.stderr[0]).toContain('--trigger must be preplan or context_cycle');
});

test('mode target cannot consume the next option token', async () => {
  const h = harness();
  expect(await runCli(['mode', 'enter', '--target', '--trigger', 'preplan'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
  expect(h.stderr[0]).toContain('--target requires a logical identity');
});

// The CLI print guard used to scan EVERY string it was about to print and throw
// on the three tmux sigils. That made the operator-visible half of the same
// defect the daemon was corrected for: txd returns an agent's answer correctly,
// and tx refuses to show it.
//
// An output string is PROSE. A print guard cannot know whether a sigil in an
// answer is an identifier or a quotation — it is not positioned to know — so it
// judges structural fields and nothing else, on the same basis as the daemon.
test('an answer that quotes a tmux id is PRINTED, not refused', async () => {
  // `comm --ask` resolves the CALLER's identity before it can print anything.
  // A process with no agent in its ancestry cannot resolve AGENT_ID, so runCli
  // refuses at identity resolution and never reaches the print path this test
  // exists to assert. Scoped and restored, matching comm.test.ts.
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const receipt = {
    ok: true,
    schema_version: 13,
    phase: 'delivery_confirmed',
    message_id: 'message-1',
    source_agent_id: 'source',
    deliveries: [],
  };
  const answer = {
    ask_id: 'ask-1',
    complete: true,
    callbacks: [{
      target: { agent_id: 'a-1', seat_id: 'palace:W', persona: 'p' },
      content: 'attesting from pane %28 with window @5 and session $5.',
      assertion_event_id: 1,
      source: 'reply',
    }],
    outstanding: [],
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === '/agents/comm') return { ok: true, message_id: 'message-1', ask_id: 'ask-1' };
      if (path === '/agents/comm/receipt') return receipt;
      return answer;
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    timezone: testTimezone,
  };
  try {
    expect(await runCli(['comm', '--ask', 'palace:W', 'report your seat'], deps)).toBe(0);
    expect(stderr).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual([
      '/agents/comm', '/agents/comm/receipt', '/agents/comm/wait',
    ]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ message_id: 'message-1', ask_id: 'ask-1' });
    expect(JSON.parse(stdout[1]!)).toEqual(receipt);
    expect(JSON.parse(stdout[2]!).callbacks[0].content)
      .toBe('attesting from pane %28 with window @5 and session $5.');
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('ordinary prose carrying sigil-shaped tokens is printed', async () => {
  for (const text of ['pin zod@4.4', 'the positional $1', 'it cost $20']) {
    const h = harness({ ok: true, message: text });
    expect(await runCli(['health'], h.deps)).toBe(0);
    expect(h.stderr).toEqual([]);
    expect(JSON.parse(h.stdout[0]!).message).toBe(text);
  }
});

// The leak-upward protection is NARROWED, not removed: an IDENTIFIER field
// carrying a raw tmux id still refuses, because that is txd leaking one.
test('an identifier field carrying a raw tmux id is still refused', async () => {
  for (const body of [
    { ok: true, seat_id: '%5' },
    { ok: true, targets: ['palace:W', '@7'] },
    { ok: true, nested: { agent_id: '$3' } },
  ]) {
    const h = harness(body);
    expect(await runCli(['health'], h.deps)).toBe(1);
    expect(h.stderr[0]).toContain('raw tmux identifier');
  }
});
