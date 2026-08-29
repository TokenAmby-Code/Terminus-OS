import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

const testTimezone = async () => 'America/Phoenix';

function harness() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true, closed_count: 1, refused_count: 0, verdicts: [], reason: null };
    },
    stdout: () => {}, stderr: () => {}, timezone: testTimezone,
  };
  return { calls, deps };
}

async function withAgentId<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.AGENT_ID;
  process.env.AGENT_ID = 'ov-1';
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = old;
  }
}

test('close forwards explicit targets, force, and the caller identity', async () => {
  const { calls, deps } = harness();
  await withAgentId(async () => {
    expect(await runCli(['close', 'w-1', 'palace:S', '--force'], deps)).toBe(0);
  });
  expect(calls[0]).toMatchObject({
    method: 'POST', path: '/agents/close',
    body: { source_agent_id: 'ov-1', targets: ['w-1', 'palace:S'], force: true },
  });
  expect((calls[0]!.body as Record<string, unknown>).page).toBeUndefined();
  expect((calls[0]!.body as Record<string, unknown>).all_idle).toBeUndefined();
});

test('close --page and --all-idle are the two filtered forms', async () => {
  const { calls, deps } = harness();
  await withAgentId(async () => {
    expect(await runCli(['close', '--page', 'palace'], deps)).toBe(0);
    expect(await runCli(['close', '--all-idle'], deps)).toBe(0);
  });
  expect(calls[0]!.body).toMatchObject({ page: 'palace' });
  expect(calls[1]!.body).toMatchObject({ all_idle: true });
});

test('close refuses selector abuse and missing identity at the CLI boundary', async () => {
  const { calls, deps } = harness();
  await withAgentId(async () => {
    expect(await runCli(['close'], deps)).toBe(1); // no selector
    expect(await runCli(['close', 'w-1', '--page', 'palace'], deps)).toBe(1); // two selectors
    expect(await runCli(['close', '--page', 'palace', '--all-idle'], deps)).toBe(1);
    expect(await runCli(['close', '--force', '--all-idle'], deps)).toBe(1); // force is explicit-targets only
    expect(await runCli(['close', '--force', '--page', 'palace'], deps)).toBe(1);
    expect(await runCli(['close', '--bogus', 'w-1'], deps)).toBe(1);
  });
  const old = process.env.AGENT_ID;
  delete process.env.AGENT_ID;
  try {
    expect(await runCli(['close', 'w-1'], deps)).toBe(1); // AGENT_ID required
  } finally {
    if (old !== undefined) process.env.AGENT_ID = old;
  }
  expect(calls).toHaveLength(0); // every refusal above is pre-transport
});
