// The run mechanisms below the membrane.
//
// Pane-shell branch: the pane prints the operator's own command plus one
// sentinel epilogue carrying `$?`, and the run rides the pane's own byte
// stream — a per-run capture armed before the line is submitted, read until
// the sentinel line, then disarmed. Nothing in the submitted line names a
// path, a file, or a socket, so the same line means the same thing in a local
// shell and in an ssh session the pane is showing.
//
// Agent branch: Claude's bash mode is entered by a literal `!` KEYSTROKE on an
// empty composer (a bracketed paste of `!` stays text and would submit a
// prompt); Codex parses a literal `!`-prefixed line at submit, so its form
// rides the verified send path whole.
import { expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { RealTmux, type PaneStreamSink, type TmuxCommandResult } from '../src/tmux.ts';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SENTINEL = `txd-run-${RUN_ID}`;

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

/** The capture transport a real run gets from a FIFO, driven by the test. */
function paneCapture() {
  const pane = new PassThrough();
  const state = { path: '/tmp/txd-run-fake/pane-stream', opened: 0, disposed: 0 };
  const sink: PaneStreamSink = {
    path: state.path,
    read: () => { state.opened += 1; return pane; },
    dispose: async () => { state.disposed += 1; pane.destroy(); },
  };
  return { pane, state, open: async () => sink };
}

test('a pane showing an ssh session runs the operator line and harvests its stream', async () => {
  const state: { calls: string[][]; payloads: string[]; workload?: string } = { calls: [], payloads: [], workload: 'ssh' };
  const capture = paneCapture();
  const tmux = new RealTmux('scratch', { run: shellPaneRunner(state), paneStream: capture.open });

  const command = 'sudo -n bash /var/tmp/r5-k12-work/r5pre.sh';
  const staged = await tmux.runInShellPane('palace:E', RUN_ID, command, new AbortController().signal);

  // In-pane print: the operator's own command, plus a sentinel epilogue that
  // names no path, no file, and no socket.
  expect(state.payloads).toEqual([`${command}; printf '\\n${SENTINEL}:%s\\n' "$?"`]);
  // The capture is armed on the pane BEFORE the line is submitted.
  expect(state.calls.filter((args) => args[0] === 'pipe-pane' || args[0] === 'send-keys')).toEqual([
    ['pipe-pane', '-t', '%7', `cat >> '${capture.state.path}'`],
    ['send-keys', '-t', '%7', 'Enter'],
  ]);

  // The pane's stream carries the output and, on its own line, the exit code.
  capture.pane.write('\x1b]0;tokenamby@k12-work\x07\x1b[32mk12-work\x1b[0m\r\n');
  capture.pane.write(`\n${SENTINEL}:7\n`);

  expect(await staged.completion).toEqual({ exit_code: 7, output: 'k12-work\n', truncated: false });
  // Disarmed once, on completion.
  expect(state.calls.filter((args) => args[0] === 'pipe-pane')).toHaveLength(2);
  expect(state.calls.at(-1)).toEqual(['pipe-pane', '-t', '%7']);
  expect(capture.state.disposed).toBe(1);
});

test('the run asks the pane no process question: readiness is never a foreground-command sniff', async () => {
  const state: { calls: string[][]; payloads: string[]; workload?: string } = { calls: [], payloads: [], workload: 'vim' };
  const capture = paneCapture();
  const tmux = new RealTmux('scratch', { run: shellPaneRunner(state), paneStream: capture.open });

  const staged = await tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal);
  capture.pane.write(`proof\n\n${SENTINEL}:0\n`);

  expect(await staged.completion).toEqual({ exit_code: 0, output: 'proof\n', truncated: false });
  expect(state.calls.some((args) => args.some((arg) => arg.includes('pane_current_command')))).toBe(false);
});

test('a refused paste never arms a capture on the pane', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  const capture = paneCapture();
  const run: Runner = async (_socket, args, stdin) => {
    const base = await shellPaneRunner(state)(_socket, args, stdin);
    if (args[0] === 'paste-buffer') return { code: 1, stdout: '', stderr: 'no such pane' };
    return base;
  };
  const tmux = new RealTmux('scratch', { run, paneStream: capture.open });

  await expect(tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal))
    .rejects.toThrow('stage_failed: palace:E');
  expect(state.calls.some((args) => args[0] === 'pipe-pane')).toBe(false);
  expect(capture.state.opened).toBe(0);
});

test('a pane whose output cannot be piped refuses capture_unarmed instead of running blind', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  const capture = paneCapture();
  const run: Runner = async (_socket, args, stdin) => {
    const base = await shellPaneRunner(state)(_socket, args, stdin);
    if (args[0] === 'pipe-pane') return { code: 1, stdout: '', stderr: 'no such pane' };
    return base;
  };
  const tmux = new RealTmux('scratch', { run, paneStream: capture.open });

  await expect(tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal))
    .rejects.toThrow('capture_unarmed: palace:E');
  expect(state.calls.some((args) => args[0] === 'send-keys')).toBe(false);
  expect(capture.state.disposed).toBe(1);
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

test('an aborted run (the pane died) rejects pane_lost_mid_run instead of reading a dead stream', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  const capture = paneCapture();
  const controller = new AbortController();
  const tmux = new RealTmux('scratch', { run: shellPaneRunner(state), paneStream: capture.open });

  const staged = await tmux.runInShellPane('palace:E', RUN_ID, 'sleep forever', controller.signal);
  controller.abort();
  await expect(staged.completion).rejects.toThrow('pane_lost_mid_run: palace:E');
});

test('the default capture reads the sink tmux appends to, woken by the sink itself', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  let sink = '';
  const run: Runner = async (socket, args, stdin) => {
    const armed = args[0] === 'pipe-pane' ? String(args[3] ?? '').match(/^cat >> '(.+)'$/) : null;
    if (armed) sink = armed[1]!;
    return shellPaneRunner(state)(socket, args, stdin);
  };
  // No injected transport: this is the sink a real run opens.
  const tmux = new RealTmux('scratch', { run });

  const staged = await tmux.runInShellPane('palace:E', RUN_ID, 'hostname', new AbortController().signal);
  expect(sink).toMatch(/pane-stream$/);

  // tmux's own `cat >>` is the writer; the harvest wakes on the append.
  await appendFile(sink, 'k12-work\r\n');
  await appendFile(sink, `\n${SENTINEL}:0\n`);

  expect(await staged.completion).toEqual({ exit_code: 0, output: 'k12-work\n', truncated: false });
  // Disarmed and collected: the sink does not outlive the run.
  expect(existsSync(sink)).toBe(false);
});

test('a capture that ends before its sentinel fails the run loudly', async () => {
  const state: { calls: string[][]; payloads: string[] } = { calls: [], payloads: [] };
  const capture = paneCapture();
  const tmux = new RealTmux('scratch', { run: shellPaneRunner(state), paneStream: capture.open });

  const staged = await tmux.runInShellPane('palace:E', RUN_ID, 'echo x', new AbortController().signal);
  capture.pane.write('half an answer\n');
  capture.pane.end();

  await expect(staged.completion).rejects.toThrow('run_stream_lost: palace:E');
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

test('a claude run is not blocked by visible composer paint', async () => {
  const calls: string[][] = [];
  const run: Runner = async (_socket, args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tcouncil:custodes\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: 'transcript\n\n❯ operator draft: do not submit\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
  });
  const outcome = await tmux.runInAgentComposer('council:custodes', RUN_ID, 'echo x', 'claude');
  expect(outcome).toEqual({ bytes: 6, verdict: 'staged' });
  expect(calls.some((args) => args[0] === 'paste-buffer')).toBe(true);
  expect(calls.some((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(true);
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

// ── Pane-input serialization across the run and send transactions ──────────

test('a concurrent verified send cannot interleave bytes into a claude shell run', async () => {
  const command = 'echo run-proof';
  const commText = 'comm bytes for the composer';
  const calls: string[][] = [];
  const payloads: string[] = [];
  let releaseRunPaste!: () => void;
  const runPasteHeld = new Promise<void>((resolve) => { releaseRunPaste = resolve; });
  let runPasteReached!: () => void;
  const runPasteStarted = new Promise<void>((resolve) => { runPasteReached = resolve; });
  const run: Runner = async (_socket, args, stdin) => {
    if (args[0] === 'load-buffer') {
      const payload = new TextDecoder().decode(stdin);
      if (payload === command) {
        // The run transaction is mid-flight: the bang keystroke landed,
        // the command's paste has not. Hold it here so a concurrent send
        // gets every chance to interleave.
        runPasteReached();
        await runPasteHeld;
      }
      calls.push(args);
      payloads.push(payload);
      return { code: 0, stdout: '', stderr: '' };
    }
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tcouncil:custodes\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const running = tmux.runInAgentComposer('council:custodes', RUN_ID, command, 'claude');
  await runPasteStarted;
  const sending = tmux.sendVerifiedToSeat('council:custodes', RUN_ID, commText);
  // Real turns for the send to misbehave in while the run is held open.
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseRunPaste();
  expect(await running).toEqual({ bytes: Buffer.byteLength(command), verdict: 'staged' });
  expect(await sending).toEqual({ bytes: Buffer.byteLength(commText), verdict: 'staged' });

  // The pane saw the run transaction whole — ! → paste → Enter — before a
  // single byte of the send entered.
  expect(payloads).toEqual([command, commText]);
  const paneInputs = calls
    .filter((args) => args[0] === 'send-keys' || args[0] === 'paste-buffer')
    .map((args) => (args[0] === 'paste-buffer' ? 'paste' : String(args.at(-1))));
  expect(paneInputs).toEqual(['!', 'paste', 'Enter', 'paste', 'Enter']);
});
