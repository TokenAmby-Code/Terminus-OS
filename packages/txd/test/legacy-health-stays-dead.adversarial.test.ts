// Adversarial: the bespoke health system and its aliases stay exterminated.

import { expect, test } from 'bun:test';

test('the STC observation surface has no actuating estate or event-write path', async () => {
  const source = await Bun.file(new URL('../src/observation.ts', import.meta.url)).text();
  for (const forbidden of ['acceptPage', 'rebuildPage', '.append(', '/ctl/health']) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).toContain('estateDivergences');
});

test('bespoke health implementation files and symbols remain absent', async () => {
  expect(await Bun.file(new URL('../src/build.ts', import.meta.url)).exists()).toBe(false);
  expect(await Bun.file(new URL('../../contracts/src/envelope.ts', import.meta.url)).exists()).toBe(false);
  const core = await Bun.file(new URL('../src/core.ts', import.meta.url)).text();
  const contracts = await Bun.file(new URL('../../contracts/src/txd.ts', import.meta.url)).text();
  expect(core).not.toContain('async health(');
  expect(core).not.toContain('unresolvedCommTransport');
  expect(contracts).not.toContain('HealthSchema');
});
