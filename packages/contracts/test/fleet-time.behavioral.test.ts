// Token-Fleet timezone consumption — behavioral-pin lane.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFleetTimezone } from '../src/fleet-time.ts';

const roots: string[] = [];
const originalTimezone = process.env.TZ;

afterEach(async () => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function machineRoot(timezone?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'terminus-fleet-time-'));
  roots.push(root);
  if (timezone !== undefined) {
    const directory = join(root, 'k12-common');
    await Bun.write(join(directory, 'runtime-baseline.json'), JSON.stringify({
      host_baseline: { timezone },
    }));
  }
  return root;
}

describe('Token-Fleet timezone boot contract', () => {
  test('loads the sole baseline declaration and sets the process zone', async () => {
    const root = await machineRoot('America/Phoenix');
    expect(await loadFleetTimezone({ TOKEN_FLEET_MACHINE_CONFIG_ROOT: root }))
      .toBe('America/Phoenix');
    expect(process.env.TZ).toBe('America/Phoenix');
  });

  test('an absent baseline fails loudly', async () => {
    const root = await machineRoot();
    await expect(loadFleetTimezone({ TOKEN_FLEET_MACHINE_CONFIG_ROOT: root }))
      .rejects.toThrow('fleet runtime baseline does not exist');
  });

  test('an invalid baseline zone fails loudly', async () => {
    const root = await machineRoot('MST-by-string-math');
    await expect(loadFleetTimezone({ TOKEN_FLEET_MACHINE_CONFIG_ROOT: root }))
      .rejects.toThrow('fleet runtime baseline carries an invalid IANA timezone');
  });

  test('txd and telemetryd both fail at process boot when the baseline is absent', async () => {
    const root = await machineRoot();
    for (const entry of [
      new URL('../../txd/src/daemon.ts', import.meta.url).pathname,
      new URL('../../telemetryd/src/daemon.ts', import.meta.url).pathname,
    ]) {
      const process = Bun.spawn(['bun', entry], {
        env: { ...globalThis.process.env, TOKEN_FLEET_MACHINE_CONFIG_ROOT: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toContain('fleet runtime baseline does not exist');
    }
  });
});
