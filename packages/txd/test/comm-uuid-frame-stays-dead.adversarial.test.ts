import { expect, test } from 'bun:test';
import { commFrameTokens } from '../src/comm-frame.ts';

const OLD = '[tx comm d251aa8e-c375-49d2-9c29-71707a245674 from 889c6bdc-cb4a-45dd-8acc-bcb01fbb98eb]';

test('adversarial: the raw-UUID-first comm header is not a frame', () => {
  expect(commFrameTokens(`${OLD}\nbody`)).toEqual([]);
});

test('adversarial: runtime source contains no producer or parser for the raw-UUID-first header', async () => {
  const core = await Bun.file(new URL('../src/core.ts', import.meta.url).pathname).text();
  const server = await Bun.file(new URL('../src/server.ts', import.meta.url).pathname).text();
  const frame = await Bun.file(new URL('../src/comm-frame.ts', import.meta.url).pathname).text();
  expect(`${core}\n${server}\n${frame}`).not.toMatch(/\[tx comm \$\{messageId\}/);
  expect(`${core}\n${server}\n${frame}`).not.toMatch(/\\\[tx comm \(\[0-9a-f\]/);
});
