// The run mechanisms below the membrane.
//
// Pane-shell branch: the command lives in a script file, the ONE staged line
// carries only fixed paths (no quoting hazard can break the epilogue), and
// completion is the pane's own `tmux wait-for` signal — armed before the line
// is typed, no polling loop, no deadline.
//
// Agent branch: Claude's bash mode is entered by a literal `!` KEYSTROKE on an
// empty composer (a bracketed paste of `!` stays text and would submit a
// prompt); Codex parses a literal `!`-prefixed line at submit, so its form
// rides the verified send path whole.
import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

type Runner = (socket: string, args: string[], stdin?: Uint8Array) => Promise<TmuxCommandResult>;

function shellPaneRunner(state: { calls: string[][]; payloads: string[]; workload?: string }): Runner {
  return async (_socket, args, stdin) => {
    state.calls.push(args);
    if (args[0] === 'list-panes' && String(args.at(-1)).includes('pane_current_command')) {
      return { code: 0, stdout: `palace:E\t${state.workload ?? 'bash'}\n`, stderr: '' };
    }
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:E\n', stderr: '' };
    if (args[0] === 'load-buffer') state.payloads.push(new TextDecoder().decode(stdin));
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('a pane run stages one fixed-path line, waits on the signal, and harvests the exact streams', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  let channel = '';
  let release!: () => void;
  const signalled = new Promise<void>((resolve) => { release = resolve; });
  const tmux = new RealTmux('scratch', {
    run: shellPaneRunner(state),
    waitForSignal: async (_socket, waited) => { channel = waited; await signalled; },
  });

  const staged = await tmux.runInShellPane('palace:E', RUN_ID, `printf 'proof: "$HOME" intact'`, new AbortController().signal);

  // The waiter is armed on the per-run channel before anything was typed.
  expect(channel).toBe(`txd-run-${RUN_ID}`);
  const line = state.payloads.at(-1)!;
  const parsed = line.match(/^bash (\S+\/run\.sh) >(\S+) 2>(\S+); printf '%s' "\$\?" >(\S+); tmux -L scratch wait-for -S (\S+)$/);
  expect(parsed).not.toBeNull();
  expect(parsed![5]).toBe(`txd-run-${RUN_ID}`);
  // The command's bytes live in the script verbatim — quotes and all.
  expect(await readFile(parsed![1]!, 'utf8')).toBe(`printf 'proof: "$HOME" intact'\n`);
  expect(state.calls.filter((args) => args[0] === 'send-keys')).toEqual([['send-keys', '-t', '%7', 'Enter']]);

  // The shell's own redirections write the harvest; the signal releases it.
  await writeFile(parsed![2]!, 'proof\n');
  await writeFile(parsed![3]!, 'warned\n');
  await writeFile(parsed![4]!, '3');
  release();
  expect(await staged.completion).toEqual({
    exit_code: 3, stdout: 'proof\n', stderr: 'warned\n',
    stdout_truncated: false, stderr_truncated: false,
  });
});

test('a pane whose foreground command is not an idle shell refuses pane_busy with the command named', async () => {
  const state: { calls: string[][]; payloads: string[]; workload?: string } = { calls: [], payloads: [], workload: 'vim' };
  const tmux = new RealTmux('scratch', {
    run: shellPaneRunner(state),
    waitForSignal: async () => { throw new Error('must not arm a waiter for a refused run'); },
  });
  await expect(tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal))
    .rejects.toThrow('pane_busy: vim');
  expect(state.payloads).toEqual([]);
});

test('a failed staging retires the armed waiter instead of stranding a wait-for client', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  let waiterAborted = false;
  const run: Runner = async (_socket, args, stdin) => {
    const base = await shellPaneRunner(state)(_socket, args, stdin);
    // The line loads, but the paste refuses: nothing was typed, so nothing
    // will ever signal the channel.
    if (args[0] === 'paste-buffer') return { code: 1, stdout: '', stderr: 'no such pane' };
    return base;
  };
  const tmux = new RealTmux('scratch', {
    run,
    waitForSignal: (_socket, _channel, signal) => new Promise((_resolve, reject) => {
      const fail = () => { waiterAborted = true; reject(new Error('pane_lost_mid_run')); };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }),
  });
  await expect(tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal))
    .rejects.toThrow('stage_failed: palace:E');
  expect(waiterAborted).toBe(true);
});

test('an unresolvable seat refuses before staging anything', async () => {
  const run: Runner = async (_socket, args) => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });
  await expect(tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal))
    .rejects.toThrow('seat_unresolved: palace:E');
});

test('an aborted run (the pane died) rejects pane_lost_mid_run instead of hanging on a dead signal', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  const controller = new AbortController();
  const tmux = new RealTmux('scratch', {
    run: shellPaneRunner(state),
    waitForSignal: (_socket, _channel, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('pane_lost_mid_run')), { once: true });
    }),
  });
  const staged = await tmux.runInShellPane('palace:E', RUN_ID, 'sleep forever', controller.signal);
  controller.abort();
  await expect(staged.completion).rejects.toThrow('pane_lost_mid_run: palace:E');
});

// ── Agent branch: Claude bash mode ─────────────────────────────────────────

const CLAUDE_IDLE = 'transcript\n\n❯ Try "how does <filepath> work?"\n\n  ? for shortcuts';

test('a claude run enters bash mode with a literal ! keystroke, pastes, verifies, and submits', async () => {
  const command = 'echo proof';
  const calls: string[][] = [];
  let capture = 0;
  const run: Runner = async (_socket, args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      capture += 1;
      // Baseline: the idle interactive paint. After input: the bash-mode
      // paint, whose prompt marker is the bang itself.
      return { code: 0, stdout: capture === 1 ? CLAUDE_IDLE : `transcript\n\n! ${command}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    observePaneOutput: async () => ({ next: async () => undefined, close: () => undefined }),
  });

  const outcome = await tmux.runInAgentComposer('council:custodes', RUN_ID, command, 'claude');

  expect(outcome).toEqual({ bytes: Buffer.byteLength(command), verdict: 'staged' });
  const keys = calls.filter((args) => args[0] === 'send-keys');
  expect(keys[0]).toEqual(['send-keys', '-t', '%7', '-l', '!']);
  expect(keys.at(-1)).toEqual(['send-keys', '-t', '%7', 'Enter']);
  // The bang is a keystroke; only the command itself rides the paste.
  const pasteIndex = calls.findIndex((args) => args[0] === 'load-buffer');
  expect(pasteIndex).toBeGreaterThan(calls.findIndex((args) => args.at(-1) === '!'));
});

test('a claude run refuses a painted composer before any key is sent', async () => {
  const calls: string[][] = [];
  const run: Runner = async (_socket, args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: 'transcript\n\n❯ operator draft: do not submit\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    observePaneOutput: async () => { throw new Error('dirty composer must refuse before arming'); },
  });
  const outcome = await tmux.runInAgentComposer('council:custodes', RUN_ID, 'echo x', 'claude');
  expect(outcome).toEqual({ bytes: 0, verdict: 'composer_corrupted' });
  expect(calls.filter((args) => ['send-keys', 'load-buffer', 'paste-buffer'].includes(args[0]!))).toHaveLength(0);
});

test('a codex run rides the verified send path with the whole !-prefixed line', async () => {
  const command = 'echo proof';
  const frame = `!${command}`;
  const calls: string[][] = [];
  const payloads: string[] = [];
  let capture = 0;
  const run: Runner = async (_socket, args, stdin) => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:N\n', stderr: '' };
    if (args[0] === 'load-buffer') payloads.push(new TextDecoder().decode(stdin));
    if (args[0] === 'capture-pane') {
      capture += 1;
      return {
        code: 0,
        stdout: capture === 1
          ? 'transcript\n\n› Summarize recent commits\n\n  gpt-5.6-sol medium'
          : `› ${frame}\n`,
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    observePaneOutput: async () => ({ next: async () => undefined, close: () => undefined }),
  });

  const outcome = await tmux.runInAgentComposer('palace:N', RUN_ID, command, 'codex');

  expect(outcome).toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged' });
  expect(payloads).toEqual([frame]);
  // No bang keystroke on codex: the bang is literal composer text there.
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === '!')).toHaveLength(0);
});

// ── The shell-mode composer verdict, pure and pinned ───────────────────────

for (const [paint, verdict] of [
  ['transcript\n\n! echo proof\n', 'intact'], // bash-mode marker paint
  ['transcript\n\n❯ ! echo proof\n', 'intact'], // caret paint, bang as text
  ['transcript\n\n! echo mangled\n', 'corrupted'],
  ['transcript with no composer at all\n', 'absent'],
] as const) {
  test(`shellComposerVerdict: ${JSON.stringify(paint.split('\n')[2] ?? paint)} → ${verdict}`, () => {
    expect(RealTmux.shellComposerVerdict(paint, 'echo proof')).toBe(verdict);
  });
}
