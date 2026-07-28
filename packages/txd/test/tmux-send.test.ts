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
  // Two pane readbacks: the first proves the swallow, the second proves submission.
  expect(calls.filter((args) => args[0] === 'capture-pane')).toHaveLength(2);
});

test('swallowed Enter is retried twice and final verdict remains honest', async () => {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%8\tpalace:S\n', stderr: '' };
    if (args[0] === 'display-message') return { code: 0, stdout: '9\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: '> dispatch the worker\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run, sleep: async (ms) => { sleeps.push(ms); }, enterDelayMs: 150 });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('partial_delivered');
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(3);
  // Every Enter was verified by pane readback, and every readback showed the swallow.
  expect(calls.filter((args) => args[0] === 'capture-pane')).toHaveLength(3);
  expect(sleeps).toEqual([150, 300, 450]);
});
