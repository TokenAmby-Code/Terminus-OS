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

test('verified send waits for a pane-output event before observing the composer', async () => {
  const calls: string[] = [];
  let releaseOutput!: () => void;
  let literalStarted!: () => void;
  const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
  const literal = new Promise<void>((resolve) => { literalStarted = resolve; });
  const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nhello';
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args[0]!);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'send-keys' && args.includes('-l')) literalStarted();
    if (args[0] === 'capture-pane') return { code: 0, stdout: `> ${frame}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async (_socket, paneId) => {
      calls.push(`arm:${paneId}`);
      return { next: async () => output, close: () => { calls.push('close'); } };
    },
  });

  const pending = tmux.sendVerifiedToSeat('palace:S', '11111111-1111-4111-8111-111111111111', frame);
  await literal;
  expect(calls).toEqual(['list-panes', 'arm:%7', 'send-keys']);
  expect(calls).not.toContain('capture-pane');

  releaseOutput();
  expect((await pending).verdict).toBe('staged');
  expect(calls).toEqual(['list-panes', 'arm:%7', 'send-keys', 'capture-pane', 'send-keys', 'close']);
});

test('behavioral pin: verified comm accepts an intact frame clipped inside the Codex composer viewport', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\n`
    + 'A long operational brief whose header scrolls above the visible textarea.\n'
    + 'The final lines remain visible and are the exact suffix the editor owns.';
  const pane = [
    '• earlier transcript remains above the composer',
    '',
    '  1 background terminal running · /ps',
    '',
    '› n visible and are the exact suffix',
    '  the editor owns.',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('intact');
});

test('behavioral pin: clipped Codex composer suffix must still match exactly', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\n`
    + 'A long operational brief whose header scrolls above the visible textarea.\n'
    + 'The final lines remain visible and are the exact suffix the editor owns.';
  const pane = [
    '  1 background terminal running · /ps',
    '',
    '› n visible and are the exact suffix',
    '  the editor is corrupted.',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('corrupted');
});

test('behavioral pin: a transcript prompt above active assistant output is not an interactive composer', () => {
  const pane = [
    '› prior operator prompt',
    '',
    '• still working on the current turn',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerInteractive(pane)).toBe(false);
});

test('verified send never submits when output settles without the expected frame', async () => {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: '> unrelated text\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', 'machine input');

  expect(outcome.verdict).toBe('composer_corrupted');
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
});

test('behavioral pin: a failed verified send restores the composer byte-for-byte', async () => {
  const before = 'operator draft: keep $ and unicode Ω';
  const injected = '[lcd event lane2.transport_proof seq=227817]\n{"nonce":"one-event"}';
  let composer = before;
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'send-keys' && args.includes('-l')) {
      composer += args.at(-1)!;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'send-keys' && args.includes('BSpace')) {
      const count = Number(args[args.indexOf('-N') + 1]);
      composer = [...composer].slice(0, -count).join('');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      // The terminal repainted before the last inserted codepoint. This is the
      // live `composer_corrupted` exhibit, while the editor still owns every
      // byte that send-keys inserted and can undo exactly that suffix.
      return { code: 0, stdout: `> ${composer.slice(0, -1)}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', injected);

  expect(outcome.verdict).toBe('composer_corrupted');
  expect(composer).toBe(before);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.includes('-l'))).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.includes('BSpace'))).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
});
