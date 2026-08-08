// The remote envelope lister folds every "no tmux server" dialect to an
// empty inventory — a target with no server holds zero envelopes — while
// any other transport or tmux failure stays a loud error.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { realRemoteEnvelopeLister } from '../src/envelopes.ts';

let tmp: string;
let originalPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'envelopes-'));
  mkdirSync(join(tmp, 'bin'));
  originalPath = process.env.PATH!;
  process.env.PATH = `${join(tmp, 'bin')}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(tmp, { recursive: true, force: true });
});

function fakeSsh(script: string): void {
  const path = join(tmp, 'bin', 'ssh');
  writeFileSync(path, `#!/usr/bin/env bash\n${script}`);
  chmodSync(path, 0o755);
}

test('a target whose tmux server never started is an empty inventory', async () => {
  fakeSsh('echo "error connecting to /tmp/tmux-1000/default (No such file or directory)" >&2; exit 1\n');
  expect(await realRemoteEnvelopeLister('k12-work')).toEqual([]);
});

test('a running-then-exited server is an empty inventory', async () => {
  fakeSsh('echo "no server running on /tmp/tmux-1000/default" >&2; exit 1\n');
  expect(await realRemoteEnvelopeLister('k12-work')).toEqual([]);
});

test('the tmux format survives ssh remote-shell reconstruction', async () => {
  const tmux = join(tmp, 'bin', 'tmux');
  writeFileSync(tmux, `#!/usr/bin/env bash
if [[ "$#" -ne 3 || "$1" != "list-sessions" || "$2" != "-F" || "$3" != '#{session_name}' ]]; then
  echo "unexpected tmux argv: $*" >&2
  exit 64
fi
printf "txd-somnium-W-abc\\ncivic-shell\\n"
`);
  chmodSync(tmux, 0o755);
  fakeSsh(`
if [[ "$1" != "-o" || "$2" != "BatchMode=yes" || "$3" != "k12-work" ]]; then
  echo "unexpected ssh argv: $*" >&2
  exit 64
fi
shift 3
exec bash -c "$*"
`);
  expect(await realRemoteEnvelopeLister('k12-work')).toEqual(['txd-somnium-W-abc', 'civic-shell']);
});

test('any other failure stays loud', async () => {
  fakeSsh('echo "Permission denied (publickey)" >&2; exit 255\n');
  await expect(realRemoteEnvelopeLister('k12-work')).rejects.toThrow('envelope_inventory_failed');
});
