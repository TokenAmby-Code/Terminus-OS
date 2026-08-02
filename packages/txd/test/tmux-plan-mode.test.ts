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

// approve_plan — the posed-plan approval oracle. A plan dialog is a LIVE
// prompt: the evidence for it must come from the current pane view only, and
// dismissal alone is not acceptance. Both are correctness pins, not style.

test('approve_plan reads only the live pane view — scrollback cannot pose a phantom dialog', async () => {
  const calls: string[][] = [];
  let dialog = true;
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%9\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      if (args.includes('-S')) return { code: 0, stdout: '⏵⏵ accept edits on · esc to interrupt\n', stderr: '' };
      return {
        code: 0,
        stdout: dialog ? 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n' : '⏵⏵ accept edits on\n',
        stderr: '',
      };
    }
    if (args[0] === 'send-keys') dialog = false;
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('test', { run });

  const outcome = await tmux.transitionAgentMode('council:custodes', 'claude', 'approve_plan');
  expect(outcome).toMatchObject({ changed: true, verified: true, mechanism: 'dialog_accept', after: 'work' });

  // Every plan-dialog observation is a bare capture of the visible pane: no
  // `-S` scrollback, so stale transcript text cannot be read as a live prompt.
  const dialogCaptures = calls.filter((args) => args[0] === 'capture-pane' && !args.includes('-S'));
  expect(dialogCaptures).toHaveLength(2);
  for (const capture of dialogCaptures) {
    expect(capture).toEqual(['capture-pane', '-p', '-J', '-t', '%9']);
  }
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%9', '1'],
  ]);
});

test('a dismissed dialog that never reaches work mode is NOT verified', async () => {
  let dialog = true;
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%9\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      // The mode oracle never leaves plan: the dialog vanished, the agent did not proceed.
      if (args.includes('-S')) return { code: 0, stdout: '⏸ plan mode on · esc to interrupt\n', stderr: '' };
      return { code: 0, stdout: dialog ? 'Would you like to proceed?\n❯ 1. Yes\n' : '⏸ plan mode on\n', stderr: '' };
    }
    if (args[0] === 'send-keys') dialog = false;
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('test', { run });

  expect(await tmux.transitionAgentMode('council:custodes', 'claude', 'approve_plan')).toMatchObject({
    after: 'plan',
    changed: false,
    verified: false,
    mechanism: 'dialog_accept',
  });
});

test('approve_plan with no posed dialog types nothing and fails loud', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%9\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: '⏸ plan mode on · esc to interrupt\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('test', { run });

  expect(await tmux.transitionAgentMode('council:custodes', 'claude', 'approve_plan')).toMatchObject({
    changed: false,
    verified: false,
    mechanism: 'none',
  });
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([]);
});

// Real chrome, harvested from live k12 estate panes on 2026-08-02. The screen
// oracle is the one part of plan mode a fake cannot prove: these are the exact
// footer strings the vendor renders, kept as fixtures so a vendor change breaks
// the pin here instead of silently disarming approve_plan in production.
const LIVE_CLAUDE_FOOTERS = [
  '  ⏵⏵ bypass permissions on           · ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ←',
];

test('the mode oracle reads real Claude footer chrome as work', () => {
  for (const footer of LIVE_CLAUDE_FOOTERS) {
    expect(RealTmux.detectAgentMode(footer, 'claude')).toBe('work');
  }
});

test('real working chrome never poses as a plan dialog', () => {
  // The dangerous direction: a false positive sends `1` into a live prompt.
  for (const footer of LIVE_CLAUDE_FOOTERS) {
    expect(RealTmux.detectPlanDialog(footer, 'claude')).toBe(false);
  }
});
