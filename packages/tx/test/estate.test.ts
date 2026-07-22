import { expect, test } from 'bun:test';
import { SCHEMA_VERSION } from '@terminus-os/contracts';
import { runCli, type CliDependencies } from '../src/cli.ts';

function harness() {
  const calls: unknown[] = [];
  const errors: string[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, body }); return { ok: true }; },
    stdout: () => {}, stderr: (line) => errors.push(line),
  };
  return { calls, errors, deps };
}

test('estate show and reconcile use the typed read/control routes', async () => {
  const h = harness();
  expect(await runCli(['estate', 'show'], h.deps)).toBe(0);
  expect(await runCli(['estate', 'reconcile'], h.deps)).toBe(0);
  expect(h.calls).toEqual([
    { method: 'GET', path: '/tmux/read/estate', body: undefined },
    { method: 'POST', path: '/ctl/reconcile', body: {} },
  ]);
});

test('estate rotate is safe by default and --force is explicit typed input', async () => {
  const h = harness();
  expect(await runCli(['estate', 'rotate'], h.deps)).toBe(0);
  expect(await runCli(['estate', 'rotate', '--force'], h.deps)).toBe(0);
  expect(h.calls).toEqual([
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: false } },
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: true } },
  ]);
});

test('estate rotate rejects every unrecognized or repeated option', async () => {
  const h = harness();
  expect(await runCli(['estate', 'rotate', '--yes'], h.deps)).toBe(1);
  expect(await runCli(['estate', 'rotate', '--force', '--force'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});
