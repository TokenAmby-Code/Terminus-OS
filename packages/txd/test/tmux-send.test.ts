// Behavioral-pin lane: comm transport is one serialized frame handoff plus Enter.

import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

function transport(pane = 'palace:S') {
  const calls: string[][] = [];
  const buffers = new Map<string, string>();
  const pasted: string[] = [];
  const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: `%7\t${pane}\n`, stderr: '' };
    if (args[0] === 'load-buffer') buffers.set(args[2]!, new TextDecoder().decode(stdin));
    if (args[0] === 'paste-buffer') pasted.push(buffers.get(args[args.indexOf('-b') + 1]!) ?? '');
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, pasted, run };
}

test('behavioral pin: a visible draft and prompt suggestion never block a comm transport', async () => {
  const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nurgent repair';
  const { calls, pasted, run } = transport();
  const tmux = new RealTmux('scratch', { run });

  expect(await tmux.sendVerifiedToSeat(
    'palace:S',
    '11111111-1111-4111-8111-111111111111',
    frame,
    undefined,
    'codex',
  )).toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged' });
  expect(pasted).toEqual([frame]);
  expect(calls.some((args) => args[0] === 'capture-pane')).toBe(false);
  expect(calls.some((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(true);
});

test('behavioral pin: concurrent comm frames remain whole serialized transactions', async () => {
  const { pasted, run } = transport();
  const tmux = new RealTmux('scratch', { run });
  const frames = ['one', 'two', 'three'].map((message) => `[tx comm ${crypto.randomUUID()} from sender]\n${message}`);

  const outcomes = await Promise.all(frames.map((frame) => tmux.sendVerifiedToSeat('palace:S', crypto.randomUUID(), frame)));

  expect(outcomes).toEqual(frames.map((frame) => ({ bytes: Buffer.byteLength(frame), verdict: 'staged' })));
  expect(pasted).toEqual(frames);
});

test('behavioral pin: a submit failure preserves possible-effect bytes without claiming staging', async () => {
  const { run: baseRun } = transport('council:fabricator-general');
  const frame = `/message ${'x'.repeat(666)}`;
  const tmux = new RealTmux('scratch', {
    run: async (socket, args, stdin) => args[0] === 'send-keys' && args.at(-1) === 'Enter'
      ? { code: 1, stdout: '', stderr: 'submit refused' }
      : baseRun(socket, args, stdin),
  });

  expect(Buffer.byteLength(frame)).toBe(675);
  expect(await tmux.sendVerifiedToSeat(
    'council:fabricator-general',
    '22e4ddc8-6f37-48a1-a231-990ea28d0c04',
    frame,
  )).toEqual({ bytes: 675, verdict: 'submit_failed' });
});

test('behavioral pin: a replaced pane generation refuses before transport effect', async () => {
  const calls: string[][] = [];
  const tmux = new RealTmux('scratch', {
    run: async (_socket, args) => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\tnew-generation\n', stderr: '' };
      if (args[0] === 'show-options') return { code: 0, stdout: 'new-generation\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  expect(await tmux.sendVerifiedToSeat(
    'palace:S',
    crypto.randomUUID(),
    'frame',
    undefined,
    'codex',
    'old-generation',
  )).toEqual({ bytes: 0, verdict: 'seat_unresolved' });
  expect(calls.some((args) => args[0] === 'paste-buffer')).toBe(false);
});

// ── Composer observation at rest — the stop-join's evidence read ───────────
// One capture when the target's stop lands (the engine is idle; the repaint
// race that killed send-time observation does not exist here). A VISIBLE
// composer that no longer holds the exact frame proves the frame left it; a
// still-painted frame refuses; no composer and no capture prove nothing.

function restTransport(stdout: string | null) {
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:W\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      return stdout === null ? { code: 1, stdout: '', stderr: 'no server' } : { code: 0, stdout, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

const REST_FRAME = '[tx comm 66666666-6666-4666-8666-666666666666 from sender]\nmid-turn frame';

test('behavioral pin: a visible composer without the frame observes frame_absent', async () => {
  const { run } = restTransport('transcript\n\n › \n\nchrome\n');
  const tmux = new RealTmux('scratch', { run });
  expect(await tmux.observeFrameAbsence('palace:W', REST_FRAME)).toBe('frame_absent');
});

test('behavioral pin: a composer still holding the exact frame observes frame_present', async () => {
  const { run } = restTransport(`transcript\n\n › ${REST_FRAME.split('\n')[0]}\n   ${REST_FRAME.split('\n')[1]}\n\nchrome\n`);
  const tmux = new RealTmux('scratch', { run });
  expect(await tmux.observeFrameAbsence('palace:W', REST_FRAME)).toBe('frame_present');
});

test('behavioral pin: no visible composer proves nothing — unobservable', async () => {
  const { run } = restTransport('bare shell output\nno prompt anywhere\n');
  const tmux = new RealTmux('scratch', { run });
  expect(await tmux.observeFrameAbsence('palace:W', REST_FRAME)).toBe('unobservable');
});

test('behavioral pin: a failed capture proves nothing — unobservable', async () => {
  const { run } = restTransport(null);
  const tmux = new RealTmux('scratch', { run });
  expect(await tmux.observeFrameAbsence('palace:W', REST_FRAME)).toBe('unobservable');
});

test('behavioral pin: an unresolvable seat is unobservable at rest', async () => {
  const run = async (args0: string, args: string[]): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', { run: run as never });
  expect(await tmux.observeFrameAbsence('palace:W', REST_FRAME)).toBe('unobservable');
});
