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

// ── Post-Enter frame-departure observation ──────────────────────────────────
// The exact frame is captured intact in the active composer before Enter and
// gone after: transport observed the frame depart into the engine. Departure
// is transport observation, never a delivery assertion by itself.

function departureTransport(frame: string, { post, failCapture }: { post?: string; failCapture?: boolean } = {}) {
  const composer = (payload: string) => `transcript line\n › ${payload}\n\nsome chrome\n`;
  const captures: string[] = [];
  let enterDriven = false;
  const buffers = new Map<string, string>();
  const pasted: string[] = [];
  const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:W\n', stderr: '' };
    if (args[0] === 'load-buffer') buffers.set(args[2]!, new TextDecoder().decode(stdin));
    if (args[0] === 'paste-buffer') pasted.push(buffers.get(args[args.indexOf('-b') + 1]!) ?? '');
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') enterDriven = true;
    if (args[0] === 'capture-pane') {
      captures.push(enterDriven ? 'post' : 'pre');
      if (failCapture) return { code: 1, stdout: '', stderr: 'no server' };
      return { code: 0, stdout: enterDriven ? (post ?? composer('')) : composer(frame), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { captures, pasted, run };
}

test('behavioral pin: an intact-then-cleared composer observation records frame departure', async () => {
  const frame = '[tx comm 33333333-3333-4333-8333-333333333333 from sender]\nmid-turn frame';
  const { captures, run } = departureTransport(frame);
  const tmux = new RealTmux('scratch', { run });

  expect(await tmux.sendVerifiedToSeat('palace:W', '33333333-3333-4333-8333-333333333333', frame))
    .toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged', frame_departed: true });
  expect(captures).toEqual(['pre', 'post']);
});

test('behavioral pin: a frame still painted after Enter stays plain staged', async () => {
  const frame = '[tx comm 44444444-4444-4444-8444-444444444444 from sender]\nsticky frame';
  const { run } = departureTransport(frame, { post: `transcript line\n › ${frame}\n\nsome chrome\n` });
  const tmux = new RealTmux('scratch', { run });

  expect(await tmux.sendVerifiedToSeat('palace:W', '44444444-4444-4444-8444-444444444444', frame))
    .toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged', frame_departed: false });
});

test('behavioral pin: an unobservable pane never blocks the transport and never claims departure', async () => {
  const frame = '[tx comm 55555555-5555-4555-8555-555555555555 from sender]\nblind frame';
  const { run } = departureTransport(frame, { failCapture: true });
  const tmux = new RealTmux('scratch', { run });

  expect(await tmux.sendVerifiedToSeat('palace:W', '55555555-5555-4555-8555-555555555555', frame))
    .toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged', frame_departed: false });
});
