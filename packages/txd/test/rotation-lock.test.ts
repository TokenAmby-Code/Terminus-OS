import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessEstateRotationBarrier } from '../src/rotation-lock.ts';

test('process barrier holds flock until the reconstructed generation completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'txd-rotation-lock-'));
  try {
    const lock = join(dir, 'estate.lock');
    const signal = join(dir, 'estate.signal');
    const barrier = new ProcessEstateRotationBarrier(lock, signal);
    await barrier.begin();

    const blocked = Bun.spawn(['/usr/bin/flock', '-n', lock, 'true']);
    expect(await blocked.exited).toBe(1);

    // A new barrier object models the reconstructed daemon generation.
    await new ProcessEstateRotationBarrier(lock, signal).complete();
    const released = Bun.spawn(['/usr/bin/flock', '-n', lock, 'true']);
    expect(await released.exited).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lock holder survives the retiring daemon process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'txd-rotation-handoff-'));
  try {
    const lock = join(dir, 'estate.lock');
    const signal = join(dir, 'estate.signal');
    const moduleUrl = new URL('../src/rotation-lock.ts', import.meta.url).href;
    const child = Bun.spawn([
      process.execPath,
      '-e',
      `import { ProcessEstateRotationBarrier } from ${JSON.stringify(moduleUrl)}; await new ProcessEstateRotationBarrier(${JSON.stringify(lock)}, ${JSON.stringify(signal)}).begin();`,
    ]);
    expect(await child.exited).toBe(0);

    const blocked = Bun.spawn(['/usr/bin/flock', '-n', lock, 'true']);
    expect(await blocked.exited).toBe(1);

    await new ProcessEstateRotationBarrier(lock, signal).complete();
    const released = Bun.spawn(['/usr/bin/flock', '-n', lock, 'true']);
    expect(await released.exited).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
