import { expect, test } from 'bun:test';

const runtimeFiles = [
  '../src/config.ts',
  '../src/core.ts',
  '../src/daemon.ts',
  '../src/events.ts',
] as const;

test('adversarial: comm delivery has no headless bypass or synthetic consumption fact', async () => {
  const runtime = (await Promise.all(runtimeFiles.map(async (path) =>
    Bun.file(new URL(path, import.meta.url)).text()))).join('\n');

  expect(runtime).not.toContain('TXD_COMM_STREAM_CLASSES');
  expect(runtime).not.toContain('commStreams');
  expect(runtime).not.toContain('headless_consumed');
  expect(runtime).not.toContain("'headless'");
});
