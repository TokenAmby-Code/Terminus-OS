import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

function harness(response: unknown = { ok: true }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, ...(body === undefined ? {} : { body }) }); return response; },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { deps, stdout, stderr, calls };
}

test('health is a registered command, not hard-coded parser behavior', async () => {
  const h = harness({ ok: true, service: 'txd' });
  expect(await runCli(['health'], h.deps)).toBe(0);
  expect(h.calls).toEqual([{ method: 'GET', path: '/ctl/health' }]);
  expect(JSON.parse(h.stdout[0]!)).toEqual({ ok: true, service: 'txd' });
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
});

test('raw tmux identifiers are rejected before CLI output', async () => {
  const h = harness({ ok: true, pane: '%12' });
  expect(await runCli(['health'], h.deps)).toBe(1);
  expect(h.stdout).toEqual([]);
  expect(h.stderr[0]).toContain('raw tmux identifier');
});

test('mode enter sends the semantic preplan transition contract', async () => {
  const h = harness({ schema_version: 9, verified: true });
  expect(await runCli([
    'mode', 'enter', '--target', 'council:custodes', '--trigger', 'preplan',
  ], h.deps)).toBe(0);
  expect(h.calls).toEqual([{
    method: 'POST',
    path: '/agents/mode',
    body: {
      schema_version: 9,
      target: 'council:custodes',
      intent: 'enter_plan',
      trigger: 'preplan',
    },
  }]);
});

test('mode toggle defaults to an operator transition', async () => {
  const h = harness({ schema_version: 9, verified: true });
  expect(await runCli(['mode', 'toggle', '--target', 'council:custodes'], h.deps)).toBe(0);
  expect(h.calls[0]).toEqual({
    method: 'POST',
    path: '/agents/mode',
    body: {
      schema_version: 9,
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
