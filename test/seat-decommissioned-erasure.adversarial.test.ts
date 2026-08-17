// Adversarial lane: the retired seat-decommissioning vocabulary stays erased.

import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const forbidden = 'seat_decommissioned';

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const target = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

test('adversarial: only this absence test may remember the retired fact name', async () => {
  const self = new URL(import.meta.url).pathname;
  const offenders: string[] = [];
  for (const path of await filesBelow(root)) {
    if (path === self || !/\.(?:ts|md|json|sql)$/.test(path)) continue;
    if ((await Bun.file(path).text()).includes(forbidden)) offenders.push(path.slice(root.length + 1));
  }
  expect(offenders).toEqual([]);
});
