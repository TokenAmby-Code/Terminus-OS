import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

test('comm CLI forwards opaque payload and exposes no format or idempotency flags', async () => {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'source';
  const calls: unknown[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, body }); return { ok: true, ask_id: null }; },
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
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, body }); return { ok: true, ask_id: null }; },
    stdout: () => {}, stderr: (line) => errors.push(line),
  };
  try {
    expect(await runCli(['comm', 'council:custodes', 'command=compact', '--', 'hard'], deps)).toBe(0);
    expect(await runCli(['comm', 'reservists:N', 'skill=openai-docs', '--', 'models'], deps)).toBe(0);
    expect(calls).toEqual([
      { method: 'POST', path: '/agents/comm', body: {
        schema_version: 11, source_agent_id: 'source', target: 'council:custodes',
        intent: { kind: 'command', name: 'compact', args: ['hard'] }, ask: false, reply: false,
      } },
      { method: 'POST', path: '/agents/comm', body: {
        schema_version: 11, source_agent_id: 'source', target: 'reservists:N',
        intent: { kind: 'skill', name: 'openai-docs', args: ['models'] }, ask: false, reply: false,
      } },
    ]);
    for (const argv of [
      ['comm', 'reservists:N', 'skill=/openai-docs'],
      ['comm', 'reservists:N', 'skill=$openai-docs'],
      ['comm', 'reservists:N', 'skill=openai-docs', '--engine=codex'],
      ['comm', '--page', 'reservists', 'command=compact'],
    ]) expect(await runCli(argv, deps)).toBe(1);
    expect(errors.join('\n')).not.toContain('choose an engine');
  } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
});
