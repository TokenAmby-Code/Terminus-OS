// Engine-specific plan-mode screen oracle and input strategy — behavioral-pin lane.

import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

test('Codex entry uses /plan and its own Plan mode read-back needle', async () => {
  let capture = 'gpt-5.6-sol medium · ~ · Main [default]\n';
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tsomnium:N\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: capture, stderr: '' };
    if (args[0] === 'send-keys' && args.includes('/plan')) {
      capture = 'gpt-5.6-sol medium · ~ · Plan mode\n';
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('test', { run });

  expect(await tmux.transitionAgentMode('somnium:N', 'codex', 'enter_plan')).toEqual({
    before: 'work',
    after: 'plan',
    changed: true,
    verified: true,
    mechanism: 'slash_command',
  });
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%7', '-l', '/plan'],
    ['send-keys', '-t', '%7', 'Enter'],
  ]);
});

test('Claude entry uses its permission-mode cycle and lowercase screen needle', async () => {
  let capture = '⏵⏵ bypass permissions on · esc to interrupt\n';
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%9\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: capture, stderr: '' };
    if (args[0] === 'send-keys') capture = '⏸ plan mode on · esc to interrupt\n';
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('test', { run });

  expect(await tmux.transitionAgentMode('council:custodes', 'claude', 'enter_plan')).toEqual({
    before: 'work',
    after: 'plan',
    changed: true,
    verified: true,
    mechanism: 'mode_cycle',
  });
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%9', 'BTab'],
  ]);
});

test('engine screen needles do not cross-classify the other harness', async () => {
  expect(RealTmux.detectAgentMode('gpt-5.6-sol medium · Plan mode\n', 'claude')).toBe('unknown');
  expect(RealTmux.detectAgentMode('⏸ plan mode on · esc to interrupt\n', 'codex')).toBe('unknown');
});
