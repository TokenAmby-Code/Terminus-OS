// One-shot OSC 52 bridge — behavioral-pin lane.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';
import {
  osc52Sequence,
  pushSelectionToClient,
  readBoundedClipboard,
  validateAttachedClientTty,
  validateClipboardBytes,
} from '../src/osc52.ts';

describe('OSC 52 encoding', () => {
  test('preserves empty, Unicode, emoji, and newlines exactly', () => {
    for (const text of ['', 'plain', 'line 1\nline 2\n', '雪 😀\t']) {
      const bytes = new TextEncoder().encode(text);
      expect(new TextDecoder().decode(osc52Sequence(bytes)))
        .toBe(`\u001b]52;c;${Buffer.from(bytes).toString('base64')}\u0007`);
    }
  });

  test('accepts 1 MiB and rejects oversize or invalid UTF-8', () => {
    expect(validateClipboardBytes(new Uint8Array(MAX_CLIPBOARD_BYTES))).toHaveLength(MAX_CLIPBOARD_BYTES);
    expect(() => validateClipboardBytes(new Uint8Array(MAX_CLIPBOARD_BYTES + 1))).toThrow('exceeds');
    expect(() => validateClipboardBytes(Uint8Array.from([0xc3, 0x28]))).toThrow('valid UTF-8');
  });

  test('stops reading stdin immediately beyond the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CLIPBOARD_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedClipboard(stream)).rejects.toThrow('exceeds');
    expect(cancelled).toBe(true);
  });
});

describe('client-scoped delivery', () => {
  test('validates against the attached-client set', () => {
    expect(validateAttachedClientTty('/dev/pts/7', ['/dev/pts/7', '/dev/pts/8'])).toBe('/dev/pts/7');
    expect(() => validateAttachedClientTty('/dev/pts/9', ['/dev/pts/7'])).toThrow('not attached');
    expect(() => validateAttachedClientTty('/tmp/fake', ['/tmp/fake'])).toThrow('invalid');
  });

  test('loads tx-clipboard and writes only the invoking tty', async () => {
    const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    const bytes = new TextEncoder().encode('exact\n😀');
    const count = await pushSelectionToClient(bytes, '/dev/pts/7', 'test', {
      run: async (args, stdin) => {
        calls.push({ args, ...(stdin ? { stdin: stdin.slice() } : {}) });
        return {
          code: 0,
          stdout: args[0] === 'list-clients' ? '/dev/pts/7\n/dev/pts/8\n' : '',
          stderr: '',
        };
      },
      writeTty: async (path, data) => { writes.push({ path, data: data.slice() }); },
    });
    expect(count).toBe(bytes.byteLength);
    expect(calls[1]).toEqual({ args: ['load-buffer', '-b', 'tx-clipboard', '-'], stdin: bytes });
    expect(calls[2]?.args).toEqual(['set-option', '-g', '@tx_clipboard_empty', '0']);
    expect(writes).toEqual([{ path: '/dev/pts/7', data: osc52Sequence(bytes) }]);
    expect(calls.at(-1)?.args).toEqual(['display-message', '-c', '/dev/pts/7', `clipboard push succeeded (${bytes.byteLength} bytes)`]);
  });

  test('rejects an unrelated tty before loading or writing', async () => {
    const calls: string[][] = [];
    let writes = 0;
    await expect(pushSelectionToClient(new TextEncoder().encode('secret'), '/dev/pts/8', 'test', {
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: '/dev/pts/7\n', stderr: '' };
      },
      writeTty: async () => { writes += 1; },
    })).rejects.toThrow('not attached');
    expect(calls).toEqual([['list-clients', '-F', '#{client_tty}']]);
    expect(writes).toBe(0);
  });

  test('reports failure and byte count without content', async () => {
    const calls: string[][] = [];
    const secret = new TextEncoder().encode('secret-content');
    await expect(pushSelectionToClient(secret, '/dev/pts/7', 'test', {
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'list-clients') return { code: 0, stdout: '/dev/pts/7\n', stderr: '' };
        if (args[0] === 'load-buffer') return { code: 1, stdout: '', stderr: 'failed' };
        return { code: 0, stdout: '', stderr: '' };
      },
      writeTty: async () => { throw new Error('not reached'); },
    })).rejects.toThrow('could not load');
    const report = calls.at(-1)?.join(' ') ?? '';
    expect(report).toContain(`clipboard push failed (${secret.byteLength} bytes)`);
    expect(report).not.toContain('secret-content');
  });

  test('reporting failure cannot replace the original delivery error', async () => {
    await expect(pushSelectionToClient(
      new TextEncoder().encode('secret'),
      '/dev/pts/7',
      'test',
      {
        run: async (args) => {
          if (args[0] === 'list-clients') return { code: 0, stdout: '/dev/pts/7\n', stderr: '' };
          if (args[0] === 'display-message') throw new Error('reporting failed');
          return { code: 1, stdout: '', stderr: 'load failed' };
        },
      },
    )).rejects.toThrow('could not load tx-clipboard');
  });
});

describe('default OSC 52 delivery path', () => {
  const socket = `tx-osc52-default-${process.pid}`;
  const channel = `tx-osc52-attached-${process.pid}`;
  let directory = '';

  afterAll(async () => {
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('uses real tmux stdin and writes only the attached pseudo-tty', async () => {
    directory = await mkdtemp(join(tmpdir(), 'tx-osc52-default-'));
    const transcript = join(directory, 'tty.log');
    expect(Bun.spawnSync([
      'tmux', '-L', socket, '-f', '/dev/null',
      'new-session', '-d', '-s', 'main',
    ]).exitCode).toBe(0);
    expect(Bun.spawnSync([
      'tmux', '-L', socket, 'set-hook', '-g', 'client-attached',
      `wait-for -S ${channel}`,
    ]).exitCode).toBe(0);

    const attached = Bun.spawn([
      'script', '-qefc', `tmux -L ${socket} attach-session -t main`, transcript,
    ], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const observed = Bun.spawn(['tmux', '-L', socket, 'wait-for', channel], {
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    expect(await observed.exited).toBe(0);

    const listed = Bun.spawnSync(['tmux', '-L', socket, 'list-clients', '-F', '#{client_tty}']);
    expect(listed.exitCode).toBe(0);
    const tty = new TextDecoder().decode(listed.stdout).trim();
    const bytes = new TextEncoder().encode('real path\n雪 😀');
    expect(await pushSelectionToClient(bytes, tty, socket)).toBe(bytes.byteLength);

    expect(Bun.spawnSync(['tmux', '-L', socket, 'save-buffer', '-b', 'tx-clipboard', '-']).stdout)
      .toEqual(Buffer.from(bytes));
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
    await attached.exited;
    expect((await readFile(transcript)).includes(osc52Sequence(bytes))).toBe(true);
  });
});
