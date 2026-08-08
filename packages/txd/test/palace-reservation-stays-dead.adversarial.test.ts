import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const reservationPattern = /EMPEROR_SEAT|palace_seat|palace[^\n]{0,80}(?:never closable|hard-refus)/i;

function runtimeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') return [];
      return runtimeFiles(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

test('adversarial: palace reservation machinery stays absent', () => {
  const files = [...runtimeFiles(root), join(root, 'README.md')];
  const matches = files.flatMap((path) => readFileSync(path, 'utf8').split('\n')
    .flatMap((line, index) => reservationPattern.test(line)
      ? [`${relative(root, path)}:${index + 1}:${line}`]
      : []));
  expect(matches).toEqual([]);
});
