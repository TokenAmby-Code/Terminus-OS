import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

// tmux can prove it PUT BYTES IN A PANE. It cannot prove the receiving agent
// consumed them: submission is a fact of the engine, reported by its
// UserPromptSubmit hook and attested as `act.comm_delivery_asserted`. So the
// send path stages and says exactly that, and nothing below the membrane may
// use a word that means received.
test('sendToSeat stages the text with one discrete Enter and claims only staging', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('staged');
  expect(outcome.bytes).toBe(19);
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%7', '-l', 'dispatch the worker'],
    ['send-keys', '-t', '%7', 'Enter'],
  ]);
});

test('a pane that cannot take the literal delivers nothing and says so', async () => {
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'send-keys' && args.includes('-l')) return { code: 1, stdout: '', stderr: 'no such pane' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('failed_none_delivered');
  expect(outcome.bytes).toBe(0);
});

// An Enter that does not land is a failed STAGE, not a quiet success: the bytes
// sit in a composer nobody submitted, which is the husk this repair exists to
// stop manufacturing.
test('an Enter that does not land refuses to report staged', async () => {
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') return { code: 1, stdout: '', stderr: 'lost server' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const outcome = await tmux.sendToSeat('palace:S', 'dispatch the worker');

  expect(outcome.verdict).toBe('failed_none_delivered');
});

// ── Adversarial: the false-positive verifier stays dead ────────────────────
//
// The excised verify() took the last non-empty line as a needle, read
// #{cursor_y}, captured that ONE row, and returned true when the needle was
// ABSENT from it. A composer holding an unsubmitted message leaves the cursor
// on a fresh BLANK row, which contains no needle — so the predicate was
// satisfied by the exact failure it existed to detect and answered
// `delivered`. On 2026-08-03 it attested four briefs to palace:N as delivered
// while that engine emitted a single UserPromptSubmit.
//
// It may not return in any form: no composer readback, no retry ladder, no
// backoff before the submit.
test('the send path never reads the composer back to guess at submission', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    // A blank cursor row: precisely the reading that fooled the old predicate.
    if (args[0] === 'capture-pane') return { code: 0, stdout: '> \n', stderr: '' };
    if (args[0] === 'display-message') return { code: 0, stdout: '12\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const outcome = await tmux.sendToSeat('palace:S', 'a multi-paragraph brief\n\nwith a trailing line');

  expect(calls.some((args) => args[0] === 'capture-pane')).toBe(false);
  expect(calls.some((args) => args[0] === 'display-message')).toBe(false);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(1);
  // Whatever the composer looked like, the outcome is staged — never delivered.
  expect(outcome.verdict).toBe('staged');
});

// The backoff knob is gone with the retry ladder it paced. A construction
// option is the seam a magic-number timeout would grow back through, so the
// absence is pinned rather than assumed.
test('there is no knob to delay or repeat the submit', () => {
  const source = Bun.file(new URL('../src/tmux.ts', import.meta.url)).text();
  return source.then((text) => {
    expect(text).not.toInclude('enterDelayMs');
    expect(text).not.toInclude('TXD_SEND_ENTER_DELAY_MS');
    expect(text).not.toInclude('verify_submit');
  });
});

test('no send outcome can spell a word that means the agent received it', async () => {
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run });

  const outcome = await tmux.sendToSeat('palace:S', 'anything at all');

  expect(['staged', 'failed_none_delivered']).toContain(outcome.verdict);
  expect(outcome.verdict).not.toBe('delivered');
  expect(outcome.verdict).not.toBe('partial_delivered');
});
