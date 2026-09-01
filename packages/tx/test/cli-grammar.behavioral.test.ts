// Behavioral-pin lane: every tx option uses the fleet key=value grammar.
import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

const timezone = async () => 'America/Phoenix';

function harness() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const errors: string[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === '/agents/comm') return { ok: true, message_id: 'message-1', ask_id: null };
      if (path === '/agents/comm/receipt') {
        return { ok: true, phase: 'delivery_confirmed', message_id: 'message-1', deliveries: [] };
      }
      if (path === '/agents/comm/wait') return { complete: true };
      if (path.startsWith('/tmux/read/diagnostics/hooks')) {
        return { ok: true, schema_version: 11, source: 'systemd-journal', identifier: 'txd-tmux-hook', diagnostics: [] };
      }
      return { ok: true };
    },
    stdout: () => {},
    stderr: (line) => errors.push(line),
    timezone,
  };
  return { calls, errors, deps };
}

test('every option-bearing tx verb accepts fleet key=value arguments', async () => {
  const prior = process.env.AGENT_ID;
  process.env.AGENT_ID = 'grammar-worker';
  const h = harness();
  try {
    expect(await runCli(['comm', 'palace:N', 'ask=true', '--', 'opaque', 'message'], h.deps)).toBe(0);
    expect(await runCli(['journal', 'dispose', 'event-seq=417', 'reason=control'], h.deps)).toBe(0);
    expect(await runCli(['inspect', 'hooks', 'limit=7'], h.deps)).toBe(0);
    expect(await runCli(['close', 'w-1', 'force=true'], h.deps)).toBe(0);
    expect(await runCli(['mode', 'enter', 'target=council:custodes', 'trigger=preplan'], h.deps)).toBe(0);
    expect(await runCli([
      'estate', 'compact-events', 'reset-journal-head=8722',
      'archive-attestation=snapshot=/backup;restore-proof=journal.head=8739',
    ], h.deps)).toBe(0);
    expect(await runCli(['estate', 'event', 'pane-exited', 'page=palace'], h.deps)).toBe(0);
    expect(await runCli(['estate', 'rotate', 'page=somnium', 'force=true'], h.deps)).toBe(0);
  } finally {
    if (prior === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = prior;
  }

  expect(h.errors).toEqual([]);
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/agents/comm', body: expect.objectContaining({
      target: 'palace:N', message: 'opaque message', ask: true,
    }),
  });
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/ctl/journal/poison/dispose', body: expect.objectContaining({
      event_seq: '417', reason: 'control',
    }),
  });
  expect(h.calls).toContainEqual({ method: 'GET', path: '/tmux/read/diagnostics/hooks?limit=7' });
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/agents/close', body: expect.objectContaining({ targets: ['w-1'], force: true }),
  });
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/agents/mode', body: expect.objectContaining({ target: 'council:custodes', trigger: 'preplan' }),
  });
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/ingress/tmux', body: expect.objectContaining({ event: 'pane-exited', page: 'palace' }),
  });
  expect(h.calls).toContainEqual({
    method: 'POST', path: '/ctl/estate/rotate', body: expect.objectContaining({ scope: 'page', page: 'somnium', force: true }),
  });
});

test('every option-bearing tx verb refuses dash options as unknown_flag', async () => {
  const h = harness();
  const invocations = [
    ['comm', '--ask', 'palace:N', 'message'],
    ['journal', 'dispose', '417', '--reason', 'control'],
    ['inspect', 'hooks', '--limit', '7'],
    ['close', 'w-1', '--force'],
    ['mode', 'enter', '--target', 'council:custodes'],
    ['estate', 'compact-events', '--reset-journal-head', '8722'],
    ['estate', 'event', 'pane-exited', '--page', 'palace'],
    ['estate', 'rotate', '--force'],
  ];
  for (const argv of invocations) {
    h.errors.length = 0;
    expect(await runCli(argv, h.deps)).toBe(64);
    expect(h.errors.join('\n')).toContain('unknown_flag');
  }
  expect(h.calls).toEqual([]);
});

test('positional-only and observation verbs also refuse dash tokens as unknown_flag', async () => {
  const h = harness();
  const invocations = [
    ['health', '--json'],
    ['inspect', '--json'],
    ['version', '--json'],
    ['comm', 'delivery', '--message-id'],
    ['run', '--target', 'true'],
    ['clipboard', 'push', '--force'],
    ['clipboard', 'pull', '--force'],
    ['estate', 'show', '--json'],
    ['estate', 'zombies', '--json'],
    ['estate', 'reconcile', '--force'],
    ['estate', 'abandon', '--seat'],
  ];
  for (const argv of invocations) {
    h.errors.length = 0;
    expect(await runCli(argv, h.deps)).toBe(64);
    expect(h.errors.join('\n')).toContain('unknown_flag');
  }
  expect(h.calls).toEqual([]);
});
