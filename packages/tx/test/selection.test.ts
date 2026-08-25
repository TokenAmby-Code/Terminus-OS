// Private selection client — behavioral-pin lane.

import { expect, test } from 'bun:test';
import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';
import { readBoundedSelection, runSelectionCommit } from '../src/selection.ts';

test('selection commit is a sensitive typed txd request with no content output', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown; options?: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const content = 'exact\n雪 😀\t';
  const code = await runSelectionCommit(['--tty', '/dev/pts/7'], {
    stdin: async () => new TextEncoder().encode(content),
    request: async (method, path, body, options) => {
      calls.push({ method, path, body, options });
      return {
        ok: true,
        target: 'k12-test',
        buffer_name: 'tx-clipboard',
        bytes: new TextEncoder().encode(content).byteLength,
      };
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  expect(code).toBe(0);
  expect(calls).toEqual([{
    method: 'POST',
    path: '/ctl/clipboard/selection',
    body: { schema_version: 13, client_tty: '/dev/pts/7', content },
    options: { sensitive: true, maxResponseBytes: 4096 },
  }]);
  expect(stdout.join('\n')).not.toContain(content);
  expect(stderr).toEqual([]);
});

test('selection stdin is bounded and invalid UTF-8 is rejected before RPC', async () => {
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_CLIPBOARD_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
  });
  await expect(readBoundedSelection(oversized)).rejects.toThrow('exceeds 1 MiB');

  let requested = false;
  const stderr: string[] = [];
  expect(await runSelectionCommit(['--tty', '/dev/pts/7'], {
    stdin: async () => Uint8Array.from([0xc3, 0x28]),
    request: async () => { requested = true; return {}; },
    stdout: () => {},
    stderr: (line) => stderr.push(line),
  })).toBe(1);
  expect(requested).toBe(false);
  expect(stderr.join('\n')).toContain('valid UTF-8');
});
