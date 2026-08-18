// Adversarial lane: the retired seat-decommissioning vocabulary stays erased.

import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(import.meta.dir, '..');
const forbidden = 'seat_decommissioned';

function repositoryTextPath(path: string): boolean {
  return /\.(?:ts|md|json|sql|yaml|yml)$/.test(path);
}

function moduleFilePath(url: URL): string {
  return fileURLToPath(url);
}

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const target = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

test('adversarial: only this absence test may remember the retired fact name', async () => {
  const self = moduleFilePath(new URL(import.meta.url));
  const offenders: string[] = [];
  for (const path of await filesBelow(root)) {
    if (path === self || !repositoryTextPath(path)) continue;
    if ((await Bun.file(path).text()).includes(forbidden)) offenders.push(path.slice(root.length + 1));
  }
  expect(offenders).toEqual([]);
});

test('adversarial: the erasure scan includes YAML and compares a decoded filesystem path', () => {
  expect(repositoryTextPath('machine.yaml')).toBe(true);
  expect(repositoryTextPath('machine.yml')).toBe(true);
  expect(moduleFilePath(new URL('file:///tmp/space%20name.ts'))).toBe('/tmp/space name.ts');
});
