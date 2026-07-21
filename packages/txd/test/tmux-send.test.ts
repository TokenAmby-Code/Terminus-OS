import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

// Behavioral-pin regression: an Enter in the literal paste burst is swallowed by
// Codex/Claude composers. Submission is only real when pane readback proves the
// sent text has left the editable cursor line.
test('paste-burst swallow is detected, then a separated Enter retry verifies submission', async () => {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let captureCount = 0;
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'display-message') return { code: 0, stdout: '12\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      captureCount += 1;
      return { code: 0, stdout: captureCount === 1 ? '> dispatch the worker\n' : '> \n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run, sleep: async (ms) => { sleeps.push(ms); }, enterDelayMs: 200 });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('delivered');
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%7', '-l', 'dispatch the worker'],
    ['send-keys', '-t', '%7', 'Enter'],
    ['send-keys', '-t', '%7', 'Enter'],
  ]);
  expect(sleeps).toEqual([200, 400]);
  expect(outcome.trace).toEqual([
    { kind: 'literal_insert', attempt: 1, ok: true },
    { kind: 'submit_enter', attempt: 1, ok: true },
    { kind: 'submit_verify', attempt: 1, ok: false },
    { kind: 'submit_enter', attempt: 2, ok: true },
    { kind: 'submit_verify', attempt: 2, ok: true },
  ]);
});

test('swallowed Enter is retried twice and final verdict remains honest', async () => {
  const sleeps: number[] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%8\tpalace:S\n', stderr: '' };
    if (args[0] === 'display-message') return { code: 0, stdout: '9\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: '> dispatch the worker\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run, sleep: async (ms) => { sleeps.push(ms); }, enterDelayMs: 150 });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('partial_delivered');
  expect(outcome.trace.filter((event) => event.kind === 'submit_enter')).toHaveLength(3);
  expect(outcome.trace.filter((event) => event.kind === 'submit_verify')).toEqual([
    { kind: 'submit_verify', attempt: 1, ok: false },
    { kind: 'submit_verify', attempt: 2, ok: false },
    { kind: 'submit_verify', attempt: 3, ok: false },
  ]);
  expect(sleeps).toEqual([150, 300, 450]);
});
