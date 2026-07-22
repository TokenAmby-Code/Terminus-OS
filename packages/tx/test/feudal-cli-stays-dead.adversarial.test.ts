import { expect, test } from 'bun:test';

// Adversarial: these removed standalone routing surfaces are named only here.
test('standalone routing packages and compatibility command paths stay absent', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json() as { bin?: Record<string, string> };
  expect(packageJson.bin).toEqual({ tx: 'src/main.ts' });

  const commands = await Bun.file(new URL('../src/commands.ts', import.meta.url)).text();
  for (const removed of ['brief', 'talk', 'comms', 'dispatch']) {
    expect(commands).not.toMatch(new RegExp(`path: \\[.${removed}`));
  }
});
