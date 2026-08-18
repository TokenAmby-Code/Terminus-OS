// Adversarial: the single-frame parser stays dead.
//
// txd used to read a prompt submission for ONE comm frame, anchored to
// character zero of the prompt. Both halves of that were wrong, and each cost
// real deliveries on 2026-08-03:
//
//   - anchored to string start: a flush whose first line was anything else
//     correlated nothing at all, and `promptSubmitted` refused the whole event.
//   - first match only: the second, third, and fourth comm in a coalesced
//     flush were read by their target and recorded as never delivered.
//
// The runtime carries no memory of that parser. These tests are the only place
// it is named, and they exist so it cannot come back by a quiet regex edit.

import { expect, test } from 'bun:test';
import { commFrameTokens, commTokenForMessageId } from '../src/comm-frame.ts';

const SERVER_SOURCE = new URL('../src/server.ts', import.meta.url).pathname;
const CONTRACTS_SOURCE = new URL('../../contracts/src/txd.ts', import.meta.url).pathname;

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

test('the frame pattern is global — a second frame can never be dropped again', async () => {
  const source = await Bun.file(new URL('../src/comm-frame.ts', import.meta.url)).text();
  const pattern = source.match(/new RegExp\([\s\S]*?'([a-z]+)',\n\);/);
  expect(pattern).not.toBeNull();
  const flags = pattern![1]!;
  // `g` finds every frame; `m` lets the line anchor reach past character zero.
  expect(flags).toContain('g');
  expect(flags).toContain('m');
});

test('no singular message_id survives on the hook contract or its parser', async () => {
  const contracts = await Bun.file(CONTRACTS_SOURCE).text();
  const hook = contracts.slice(contracts.indexOf('export const CommHookSchema'));
  const body = hook.slice(0, hook.indexOf('});'));
  expect(body).toContain('comm_tokens');
  // Not `message_id:` — the plural is the whole contract, with no singular
  // field beside it to quietly become the one anything reads.
  expect(body).not.toMatch(/\bmessage_ids?\s*:/);

  const server = await Bun.file(SERVER_SOURCE).text();
  const input = server.slice(server.indexOf('function promptHookInput'));
  expect(input.slice(0, input.indexOf('\n}'))).not.toMatch(/\bmessage_ids?\s*:/);
});

test('a four-frame flush yields four ids, not one', () => {
  const prompt = [1, 2, 3, 4].map((n) => `[tx comm from custodes at council:custodes #${commTokenForMessageId(uuid(n))}]\nbody ${n}`).join('\n');
  expect(commFrameTokens(prompt)).toHaveLength(4);
});

test('the parser does not require the frame at character zero', () => {
  const token = commTokenForMessageId(uuid(1));
  expect(commFrameTokens(`preamble the composer already held\n[tx comm from custodes at council:custodes #${token}]\nbody`))
    .toEqual([token]);
});

test('no delay, retry, or submit-repeat knob returns alongside the parser fix', async () => {
  // PR #93 excised the enter delay and its retry ladder; the Emperor ruled on
  // 2026-08-03 that no magic-number wait returns. This fix is a parser change
  // and must not smuggle one back in.
  const source = await Bun.file(new URL('../src/tmux.ts', import.meta.url).pathname).text();
  expect(source).not.toMatch(/enterDelay|ENTER_DELAY|setTimeout|Bun\.sleep|sleep\(/);
});
