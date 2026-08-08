import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const removedIdentity = /FLEET_INSTANCE_ID|instance_id|wrapper_id|source_instance|subscriber_instance|target_instance|STATIC_PERSONAS|static[_ -]persona|static[_ -]handshake|static[_ -]launch/i;

function runtimeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'migrations' || entry.name === 'node_modules') return [];
      return runtimeFiles(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

test('adversarial: removed identity namespaces stay absent from runtime and documentation', () => {
  const matches = [...runtimeFiles(join(root, 'packages')), join(root, 'README.md')]
    .flatMap((path) => readFileSync(path, 'utf8').split('\n')
      .flatMap((line, index) => removedIdentity.test(line)
        ? [`${relative(root, path)}:${index + 1}:${line}`]
        : []));
  expect(matches).toEqual([]);
});
