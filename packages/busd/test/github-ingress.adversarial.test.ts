// Adversarial lane: asserts an erased surface STAYS erased. This file is the
// only place allowed to remember it; runtime code never acknowledges it.

import { expect, test } from 'bun:test';
import * as contracts from '@terminus-os/contracts';
import { MemoryBusStore } from '../src/store.ts';
import { MemoryReplayStore } from '../src/replay-store.ts';
import { makeServer } from '../src/server.ts';

const build = { version: '0.1.0', git_sha: 'test', bun: '1.0' };

test('adversarial: POST /ingress/github is an unknown route exactly like any other — no tombstone', async () => {
  const srv = makeServer({
    bind: '127.0.0.1',
    port: 0,
    store: new MemoryBusStore(),
    replayStore: new MemoryReplayStore(),
    onAppend: () => {},
    build,
    machine: 'test',
  });
  try {
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${srv.port}${path}`, { method: 'POST', body: '{}' });
    const [github, unknown] = await Promise.all([
      post('/ingress/github'),
      post('/ingress/route-that-never-existed'),
    ]);
    // Equivalence to an arbitrary unknown route: same status, same body shape
    // (the path echo neutralized) — no dedicated branch may distinguish them.
    expect(github.status).toBe(unknown.status);
    const githubBody = (await github.json()) as Record<string, unknown>;
    const unknownBody = (await unknown.json()) as Record<string, unknown>;
    expect({ ...githubBody, path: null }).toEqual({ ...unknownBody, path: null });
  } finally {
    srv.stop(true);
  }
});

test('adversarial: no github normalization export resurrects in the contracts surface', () => {
  for (const name of ['parseGithubNormalizedPayload', 'GithubNormalizedPayloadSchemas']) {
    expect(name in contracts).toBe(false);
  }
});

test('adversarial: busd runtime sources never mention a github receiver', async () => {
  const sources = await Promise.all(
    ['build.ts', 'config.ts', 'daemon.ts', 'dispatcher.ts', 'replay-store.ts', 'server.ts', 'store.ts']
      .map((name) => Bun.file(new URL(`../src/${name}`, import.meta.url)).text()),
  );
  expect(sources.join('\n')).not.toMatch(/github/i);
});
