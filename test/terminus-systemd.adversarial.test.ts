// @terminus-os/systemd extermination — adversarial lane.
// Readiness belongs to the STC runtime contract. Keep the duplicate workspace
// package and imports from returning.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('@terminus-os/systemd stays absent', async () => {
  expect(existsSync(join(root, 'packages/systemd'))).toBe(false);

  const manifests = [
    'package.json',
    'packages/txd/package.json',
    'packages/telemetryd/package.json',
  ];
  for (const manifest of manifests) {
    expect(await Bun.file(join(root, manifest)).text()).not.toContain('@terminus-os/systemd');
  }
});
