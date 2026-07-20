// Adversarial lane: sqlite is dead REPO-WIDE — PostgreSQL 18 is the only
// persistence in Terminus-OS (ruled 2026-07-20). This is not a behavioral pin;
// it is a legacy-stays-dead assertion over the entire tracked tree:
//
//  - no sqlite dependency, import (`bun:sqlite`), or `.sqlite` path anywhere
//  - no `dbPath` config field
//  - no `runtimes/database` path string
//
// The scan walks every git-tracked file (code, config, docs, lockfile) so a
// re-introduction anywhere — a dependency, a doc snippet, a unit file — fails
// loud with the exact file:line.

import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const SELF = 'packages/txd/test/sqlite-stays-dead.adversarial.test.ts';
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'sqlite', re: /sqlite/i },
  { name: 'dbPath', re: /dbPath/ },
  { name: 'runtimes/database', re: /runtimes\/database/ },
];

function trackedFiles(): string[] {
  const proc = Bun.spawnSync(['git', 'ls-files'], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().split('\n').filter((f) => f.length > 0 && f !== SELF);
}

describe('adversarial: sqlite stays dead repo-wide', () => {
  test('no tracked file mentions sqlite, dbPath, or runtimes/database', async () => {
    const violations: string[] = [];
    for (const file of trackedFiles()) {
      const text = await Bun.file(join(root, file)).text();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const { name, re } of BANNED) {
          if (re.test(lines[i]!)) violations.push(`${file}:${i + 1} [${name}] ${lines[i]!.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no package depends on any sqlite driver', () => {
    for (const file of trackedFiles().filter((f) => f.endsWith('package.json'))) {
      const pkg = require(join(root, file)) as Record<string, Record<string, string> | undefined>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        expect(Object.keys(pkg[key] ?? {}).filter((d) => /sqlite/i.test(d))).toEqual([]);
      }
    }
  });
});
