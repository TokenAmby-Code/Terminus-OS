// Explicit local-device clipboard commands — behavioral-pin lane.

import { expect, test } from 'bun:test';
import { CLIPBOARD_BUFFER_NAME, SCHEMA_VERSION } from '@terminus-os/contracts';
import { runCli, type CliDependencies } from '../src/cli.ts';
import { createLocalClipboard, runProcess, type LocalClipboard } from '../src/clipboard.ts';

function harness(response: unknown, clipboard: LocalClipboard) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps: CliDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return response;
    },
    clipboard: () => clipboard,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { deps, stdout, stderr, calls };
}

test('push sets only the local adapter and never prints content', async () => {
  const content = '雪 😀\ntrailing  ';
  const set: string[] = [];
  const h = harness({
    ok: true,
    target: 'k12-personal',
    buffer_name: CLIPBOARD_BUFFER_NAME,
    bytes: new TextEncoder().encode(content).byteLength,
    content_base64: Buffer.from(content).toString('base64'),
  }, {
    target: 'windows',
    get: async () => { throw new Error('not called'); },
    set: async (value) => { set.push(value); },
  });
  expect(await runCli(['clipboard', 'push'], h.deps)).toBe(0);
  expect(set).toEqual([content]);
  expect(h.calls).toEqual([{
    method: 'POST',
    path: '/ctl/clipboard/push',
    body: { schema_version: SCHEMA_VERSION, buffer_name: CLIPBOARD_BUFFER_NAME },
  }]);
  expect(h.stdout.join('\n')).not.toContain(content);
  expect(JSON.parse(h.stdout[0]!)).toMatchObject({ target: 'k12-personal', direction: 'push', local: 'windows' });
});

test('pull loads only the named remote buffer and never injects or prints content', async () => {
  const content = 'echo never-run\nexit\n';
  const bytes = new TextEncoder().encode(content).byteLength;
  const h = harness({
    ok: true,
    target: 'k12-work',
    buffer_name: CLIPBOARD_BUFFER_NAME,
    bytes,
  }, {
    target: 'android',
    get: async () => content,
    set: async () => { throw new Error('not called'); },
  });
  expect(await runCli(['clipboard', 'pull'], h.deps)).toBe(0);
  expect(h.calls).toEqual([{
    method: 'POST',
    path: '/ctl/clipboard/pull',
    body: { schema_version: SCHEMA_VERSION, content },
  }]);
  expect(h.stdout.join('\n')).not.toContain(content);
  expect(JSON.parse(h.stdout[0]!)).toMatchObject({ target: 'k12-work', direction: 'pull', local: 'android', bytes });
});

test('WSL uses PowerShell raw get and stdin-only set', async () => {
  const calls: Array<{ argv: string[]; stdin?: Uint8Array }> = [];
  const adapter = createLocalClipboard({ WSL_DISTRO_NAME: 'Ubuntu' }, async (argv, stdin) => {
    calls.push({ argv, ...(stdin ? { stdin: stdin.slice() } : {}) });
    return { code: 0, stdout: new TextEncoder().encode('from windows'), stderr: '' };
  });
  expect(await adapter.get()).toBe('from windows');
  await adapter.set('to windows');
  expect(calls[0]?.argv.at(-1)).toContain('Get-Clipboard -Raw');
  expect(calls[0]?.argv.at(-1)).toContain('OutputEncoding');
  expect(calls[1]?.argv.at(-1)).toContain('[Console]::In.ReadToEnd()');
  expect(calls[1]?.argv.at(-1)).toContain('InputEncoding');
  expect(new TextDecoder().decode(calls[1]?.stdin)).toBe('to windows');
  expect(calls[1]?.argv.join(' ')).not.toContain('to windows');
});

test('Termux uses Termux:API commands and reports capability failure clearly', async () => {
  const argv: string[][] = [];
  const adapter = createLocalClipboard({ TERMUX_VERSION: '1' }, async (args) => {
    argv.push(args);
    return { code: 127, stdout: new Uint8Array(), stderr: 'missing' };
  });
  await expect(adapter.get()).rejects.toThrow('Termux:API clipboard');
  expect(argv).toEqual([['termux-clipboard-get']]);
});

test('other devices fail instead of inventing a clipboard route', () => {
  expect(() => createLocalClipboard({})).toThrow('run tx clipboard from WSL or Termux');
});

test('malformed service responses cannot mutate the local clipboard', async () => {
  let writes = 0;
  const h = harness({ ok: true, content_base64: Buffer.from('secret').toString('base64') }, {
    target: 'windows',
    get: async () => '',
    set: async () => { writes += 1; },
  });
  expect(await runCli(['clipboard', 'push'], h.deps)).toBe(1);
  expect(writes).toBe(0);
  expect(h.stderr.join('\n')).toContain('invalid clipboard response');
  expect(h.stderr.join('\n')).not.toContain('secret');
});

test('local clipboard subprocess stderr is bounded', async () => {
  await expect(runProcess([
    '/bin/sh',
    '-c',
    'head -c 1048577 /dev/zero >&2',
  ])).rejects.toThrow('local clipboard exceeds 1 MiB');
});
