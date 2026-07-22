import { expect, test } from 'bun:test';
import { runCli, type CliDependencies } from '../src/cli.ts';

test('comm CLI forwards opaque payload and exposes no format or idempotency flags', async () => {
  const old = process.env.TX_INSTANCE_ID;
  process.env.TX_INSTANCE_ID = 'source';
  const calls: unknown[] = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => { calls.push({ method, path, body }); return { ok: true, ask_id: null }; },
    stdout: () => {}, stderr: () => {},
  };
  try {
    expect(await runCli(['comm', 'pax', '---\n{"λ":true}'], deps)).toBe(0);
    expect(calls[0]).toMatchObject({ path: '/agents/comm', body: { source_instance_id: 'source', target: 'pax', message: '---\n{"λ":true}', ask: false } });
    expect(await runCli(['comm', '--json', '{}'], deps)).toBe(1);
    expect(await runCli(['comm', '--idempotency-key', 'x'], deps)).toBe(1);
    expect(await runCli(['comm', '--ephemeral', 'x'], deps)).toBe(1);
  } finally {
    if (old === undefined) delete process.env.TX_INSTANCE_ID; else process.env.TX_INSTANCE_ID = old;
  }
});
