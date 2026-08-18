import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

test('comm CLI forwards opaque payload and exposes no format or idempotency flags', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const calls: unknown[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return path === '/agents/comm'
        ? { ok: true, message_id: 'message-1', ask_id: null }
        : { ok: true, phase: 'bytes_sent', message_id: 'message-1', source_agent_id: 'source', targets: [], bytes_sent: 1, staged: true, event_ids: [] };
    },
    stdout: () => {}, stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'pax', '---\n{"λ":true}'], deps)).toBe(0);
    expect(calls[0]).toMatchObject({ path: '/agents/comm', body: { source_agent_id: 'source', target: 'pax', message: '---\n{"λ":true}', ask: false } });
    expect(await runCli(['comm', '--json', '{}'], deps)).toBe(1);
    expect(await runCli(['comm', '--idempotency-key', 'x'], deps)).toBe(1);
    expect(await runCli(['comm', '--ephemeral', 'x'], deps)).toBe(1);
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('behavioral pin: command and skill intents never expose engine syntax or a switcher', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const calls: unknown[] = [];
  const errors: string[] = [];
  let sequence = 0;
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === '/agents/comm') return { ok: true, message_id: `message-${++sequence}`, ask_id: null };
      return { ok: true, phase: 'bytes_sent', message_id: `message-${sequence}`, source_agent_id: 'source', targets: [], bytes_sent: 1, staged: true, event_ids: [] };
    },
    stdout: () => {}, stderr: (line) => errors.push(line),
  };
  try {
    expect(await runCli(['comm', 'council:custodes', 'command=compact', '--', 'hard'], deps)).toBe(0);
    expect(await runCli(['comm', 'palace:N', 'skill=openai-docs', '--', 'models'], deps)).toBe(0);
    expect(calls.filter((call) => (call as { path: string }).path === '/agents/comm')).toEqual([
      { method: 'POST', path: '/agents/comm', body: {
        schema_version: 11, source_agent_id: 'source', target: 'council:custodes',
        intent: { kind: 'command', name: 'compact', args: ['hard'] }, ask: false, reply: false,
      } },
      { method: 'POST', path: '/agents/comm', body: {
        schema_version: 11, source_agent_id: 'source', target: 'palace:N',
        intent: { kind: 'skill', name: 'openai-docs', args: ['models'] }, ask: false, reply: false,
      } },
    ]);
    expect(calls.filter((call) => (call as { path: string }).path === '/agents/comm/receipt')).toHaveLength(2);
    for (const argv of [
      ['comm', 'palace:N', 'skill=/openai-docs'],
      ['comm', 'palace:N', 'skill=$openai-docs'],
      ['comm', 'palace:N', 'skill=openai-docs', '--engine=codex'],
      ['comm', '--page', 'palace', 'command=compact'],
    ]) expect(await runCli(argv, deps)).toBe(1);
    expect(errors.join('\n')).not.toContain('choose an engine');
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('behavioral pin: comm recovery derives the operator from AGENT_ID and names only a logical target', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'recovery-operator';
  const calls: unknown[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true, message_id: '34766e7c-9e06-4a9c-b12a-52ca5f6d440f', outcome: 'enter_redriven' };
    },
    stdout: () => {}, stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'recover', 'council:fabricator-general'], deps)).toBe(0);
    expect(calls).toEqual([{ method: 'POST', path: '/agents/comm/recover', body: {
      schema_version: 11,
      source_agent_id: 'recovery-operator',
      target: 'council:fabricator-general',
      discard_corrupted: false,
    } }]);
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('tier 1: an on-time delivery attestation is the sole comm return value', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const stdout: string[] = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const deps: CliDependencies = {
    request: async (_method, path, body) => {
      calls.push({ path, body });
      if (path === '/agents/comm') return { ok: true, message_id: 'message-1', ask_id: null };
      return {
        ok: true,
        phase: 'delivery_confirmed',
        message_id: 'message-1',
        source_agent_id: 'source',
        deliveries: [{ target: { agent_id: 'target', seat_id: 'palace:W', persona: null }, delivered: true, asserted_at: '2026-08-15T17:00:01.000Z', assertion_event_id: 42 }],
      };
    },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'target', 'hello'], deps)).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(['/agents/comm', '/agents/comm/receipt']);
    expect(calls[1]?.body).toEqual({ schema_version: 11, message_id: 'message-1', source_agent_id: 'source' });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!).phase).toBe('delivery_confirmed');
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('tier 2: the bounded wait returns bytes sent as the sole comm return value', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const stdout: string[] = [];
  const deps: CliDependencies = {
    request: async (_method, path) => path === '/agents/comm'
      ? { ok: true, message_id: 'message-2', ask_id: null }
      : { ok: true, phase: 'bytes_sent', message_id: 'message-2', source_agent_id: 'source', bytes_sent: 5, staged: true, targets: [] },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'target', 'hello'], deps)).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ phase: 'bytes_sent', bytes_sent: 5 });
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});

test('behavioral pin: a typed comm transport refusal is printed and exits non-zero', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const stdout: string[] = [];
  const deps: CliDependencies = {
    request: async (_method, path) => path === '/agents/comm'
      ? { ok: true, message_id: 'message-refused', ask_id: null }
      : {
          ok: false,
          phase: 'transport_refused',
          message_id: 'message-refused',
          source_agent_id: 'source',
          targets: [{ agent_id: 'target', seat_id: 'palace:W', persona: null }],
          bytes_sent: 0,
          submit_verdict: 'composer_unreadable',
          event_ids: [99],
        },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'target', 'hello'], deps)).toBe(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      ok: false,
      phase: 'transport_refused',
      submit_verdict: 'composer_unreadable',
    });
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});
