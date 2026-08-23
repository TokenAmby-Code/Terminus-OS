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
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: false, scope: 'estate' } },
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: true, scope: 'estate' } },
  ]);
});

test('estate rotate rejects every unrecognized or repeated option', async () => {
  const h = harness();
  expect(await runCli(['estate', 'rotate', '--yes'], h.deps)).toBe(1);
  expect(await runCli(['estate', 'rotate', '--force', '--force'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});

test('estate rotate targets one canonical page or pane without widening scope', async () => {
  const h = harness();
  expect(await runCli(['estate', 'rotate', '--page', 'somnium', '--force'], h.deps)).toBe(0);
  expect(await runCli(['estate', 'rotate', '--pane', 'somnium:NE', '--force'], h.deps)).toBe(0);
  expect(h.calls).toEqual([
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: 'somnium' } },
    { method: 'POST', path: '/ctl/estate/rotate', body: { schema_version: SCHEMA_VERSION, force: true, scope: 'pane', pane: 'somnium:NE' } },
  ]);
});

test('estate rotate rejects ambiguous or incomplete scoped options', async () => {
  const h = harness();
  expect(await runCli(['estate', 'rotate', '--page'], h.deps)).toBe(1);
  expect(await runCli(['estate', 'rotate', '--pane', 'somnium:NE', '--page', 'somnium'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});

test('tmux lifecycle events enter txd through a typed page event', async () => {
  const h = harness();
  expect(await runCli(['estate', 'event', 'pane-exited', '--page', 'palace'], h.deps)).toBe(0);
  expect(h.calls).toEqual([
    { method: 'POST', path: '/ingress/tmux', body: { schema_version: SCHEMA_VERSION, event: 'pane-exited', page: 'palace' } },
  ]);
});

test('event-log compaction requires an explicit archive attestation and reset head', async () => {
  const requests: unknown[] = [];
  const output: unknown[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    requests.push({ method, path, body });
    return { ok: true, boundary_seq: 7, archived_events: 6, retained_events: 5 };
  };
  const env = process.env.AGENT_ID;
  process.env.AGENT_ID = 'operator-agent';
  try {
    expect(await runCli([
      'estate', 'compact-events',
      '--reset-journal-head', '8722',
      '--archive-attestation', 'snapshot=~/backups/reset-point-2026-08-23;restore-proof=journal.head=8739',
    ], { request, stdout: (line) => output.push(JSON.parse(line)), stderr: () => {} })).toBe(0);
  } finally {
    if (env === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = env;
  }
  expect(requests).toEqual([{
    method: 'POST',
    path: '/ctl/estate/compact-events',
    body: {
      schema_version: SCHEMA_VERSION,
      source_agent_id: 'operator-agent',
      reset_journal_head: 8722,
      archive_attestation: 'snapshot=~/backups/reset-point-2026-08-23;restore-proof=journal.head=8739',
    },
  }]);
  expect(output).toEqual([{ ok: true, boundary_seq: 7, archived_events: 6, retained_events: 5 }]);
});

test('event-log compaction refuses locally when archive attestation is absent', async () => {
  let requested = false;
  expect(await runCli(
    ['estate', 'compact-events', '--reset-journal-head', '8722'],
    { request: async () => { requested = true; }, stdout: () => {}, stderr: () => {} },
  )).toBe(1);
  expect(requested).toBe(false);
});

test('tmux lifecycle event input rejects unknown events and incomplete pages', async () => {
  const h = harness();
  expect(await runCli(['estate', 'event', 'mystery', '--page', 'palace'], h.deps)).toBe(1);
  expect(await runCli(['estate', 'event', 'pane-died', '--page'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});

test('a kill-time event is page-less: tx forwards pane-killed with no page claim', async () => {
  const h = harness();
  expect(await runCli(['estate', 'event', 'pane-killed'], h.deps)).toBe(0);
  expect(h.calls).toEqual([
    { method: 'POST', path: '/ingress/tmux', body: { schema_version: SCHEMA_VERSION, event: 'pane-killed' } },
  ]);
});

test('pane-killed refuses a page claim and process-death events still demand one', async () => {
  const h = harness();
  expect(await runCli(['estate', 'event', 'pane-killed', '--page', 'palace'], h.deps)).toBe(1);
  expect(await runCli(['estate', 'event', 'pane-exited'], h.deps)).toBe(1);
  expect(h.calls).toEqual([]);
});
