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
  expect(await runCli(['estate', 'show'], h.deps)).toBe(2);
  expect(h.stderr[0]).toContain('unknown command: estate show');
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
