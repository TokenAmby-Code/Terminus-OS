// txd-owned selection commit — behavioral-pin lane.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeTmux, RealTmux, type TmuxAuditRecord } from '../src/tmux.ts';

const machineRegistry = { machines: { wsl: { tailscaleIp: '100.66.10.74' } } };
const observedWsl = (tty: string) => ({
  requested_tty: tty,
  attached_clients: [{ tty, process_id: 71 }],
  process_ancestors: {
    71: { parent_process_id: 70, command: 'tmux attach' },
    70: { parent_process_id: 1, command: 'tailscaled ssh --remote-ip=100.66.10.74' },
  },
});

test('the adapter validates the attached client before mutating and targets one tty', async () => {
  const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
  const audits: TmuxAuditRecord[] = [];
  const text = 'exact\n雪 😀';
  const bytes = new TextEncoder().encode(text);
  const tmux = new RealTmux('test', {
    run: async (_socket, args, stdin) => {
      calls.push({ args, ...(stdin ? { stdin: stdin.slice() } : {}) });
      return {
        code: 0,
        stdout: args[0] === 'list-clients' ? '/dev/pts/7\n/dev/pts/8\n' : '',
        stderr: '',
      };
    },
    machineRegistry,
    observeClipboardOrigin: async (tty) => observedWsl(tty),
    audit: (record) => audits.push(record),
  });

  expect(await tmux.commitClipboardSelection(text, '/dev/pts/7')).toEqual({ outcome: 'delivered', origin: 'wsl', bytes: bytes.byteLength });
  expect(calls[0]).toEqual({
    args: ['load-buffer', '-w', '-b', 'tx-clipboard', '-t', '/dev/pts/7', '-'],
    stdin: bytes,
  });
  expect(calls[1]?.args).toEqual(['set-option', '-g', '@tx_clipboard_empty', '0']);
  expect(calls.at(-1)?.args).toEqual([
    'display-message', '-c', '/dev/pts/7',
    `clipboard delivered (${bytes.byteLength} bytes)`,
  ]);
  const serializedAudits = JSON.stringify(audits);
  expect(serializedAudits).not.toContain(text);
  expect(serializedAudits).not.toContain('/dev/pts/7');
});

test('the adapter rejects an unrelated tty without changing the buffer or writing', async () => {
  const calls: string[][] = [];
  let writes = 0;
  const tmux = new RealTmux('test', {
    run: async (_socket, args) => {
      calls.push(args);
      return { code: 0, stdout: '/dev/pts/7\n', stderr: '' };
    },
    writeClient: async () => { writes += 1; },
    machineRegistry,
    observeClipboardOrigin: async (tty) => ({ ...observedWsl(tty), attached_clients: [] }),
    audit: () => {},
  });
  await expect(tmux.commitClipboardSelection('secret', '/dev/pts/8')).resolves.toEqual({ outcome: 'disconnected_origin', bytes: 6 });
  expect(calls).toEqual([['display-message', '-c', '/dev/pts/8', 'clipboard disconnected_origin (6 bytes)']]);
  expect(writes).toBe(0);
});

test('selection failure reports byte count without content', async () => {
  const calls: string[][] = [];
  const secret = 'never-report-selection-content';
  const tmux = new RealTmux('test', {
    run: async (_socket, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    writeClient: async () => { throw new Error('private terminal refusal detail'); },
    machineRegistry,
    observeClipboardOrigin: async (tty) => observedWsl(tty),
    audit: () => {},
  });
  await expect(tmux.commitClipboardSelection(secret, '/dev/pts/7')).resolves.toEqual({
    outcome: 'transport_refused', origin: 'wsl', bytes: new TextEncoder().encode(secret).byteLength,
  });
  const report = calls.at(-1)?.join(' ') ?? '';
  expect(report).toContain(`clipboard transport_refused (${new TextEncoder().encode(secret).byteLength} bytes)`);
  expect(report).not.toContain(secret);
});

test('an empty selection is refused because tmux cannot emit an exact target-scoped clear', async () => {
  const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
  const tmux = new RealTmux('test', {
    run: async (_socket, args, stdin) => {
      calls.push(stdin === undefined ? { args } : { args, stdin });
      return { code: 0, stdout: '', stderr: '' };
    },
    machineRegistry,
    observeClipboardOrigin: async (tty) => observedWsl(tty),
    audit: () => {},
  });

  await expect(tmux.commitClipboardSelection('', '/dev/pts/7')).resolves.toEqual({
    outcome: 'transport_refused', origin: 'wsl', bytes: 0,
  });
  expect(calls).toEqual([{
    args: ['display-message', '-c', '/dev/pts/7', 'clipboard transport_refused (0 bytes)'],
  }]);
});

test('the fake adapter cannot claim an empty selection was delivered', async () => {
  const tmux = new FakeTmux();
  tmux.attachClient('/dev/pts/7');
  await expect(tmux.commitClipboardSelection('', '/dev/pts/7')).resolves.toEqual({
    outcome: 'transport_refused', origin: 'wsl', bytes: 0,
  });
  expect(tmux.selectionDeliveries()).toEqual([]);
});

describe('real adapter selection path', () => {
  const socket = `tx-selection-${process.pid}`;
  const channel = `tx-selection-attached-${process.pid}`;
  let directory = '';

  afterAll(async () => {
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('loads the named buffer and asks tmux to copy only through the attached client', async () => {
    directory = await mkdtemp(join(tmpdir(), 'tx-selection-'));
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
    const text = 'real path\n雪 😀';
    const bytes = new TextEncoder().encode(text);
    const tmux = new RealTmux(socket, {
      audit: () => {},
      machineRegistry,
      observeClipboardOrigin: async (target) => observedWsl(target),
    });

    expect(await tmux.commitClipboardSelection(text, tty)).toEqual({ outcome: 'delivered', origin: 'wsl', bytes: bytes.byteLength });
    expect(Bun.spawnSync(['tmux', '-L', socket, 'save-buffer', '-b', 'tx-clipboard', '-']).stdout)
      .toEqual(Buffer.from(bytes));
    expect(await tmux.commitClipboardSelection('', tty)).toEqual({ outcome: 'transport_refused', origin: 'wsl', bytes: 0 });
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
    await attached.exited;
    const rendered = await readFile(transcript);
    expect(rendered.includes(new TextEncoder().encode(Buffer.from(bytes).toString('base64')))).toBe(true);
  });
});
