// Real disposable tmux clipboard fidelity — behavioral-pin integration lane.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RealTmux } from '../src/tmux.ts';

const socket = `tx-clipboard-test-${process.pid}`;

beforeAll(() => {
  const started = Bun.spawnSync(['tmux', '-L', socket, '-f', '/dev/null', 'new-session', '-d']);
  if (started.exitCode !== 0) throw new Error(new TextDecoder().decode(started.stderr));
});

afterAll(() => {
  Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
});

test('real tmux load/save preserves exact UTF-8 without pane input', async () => {
  const tmux = new RealTmux(socket, { audit: () => {} });
  for (const content of [
    '',
    'wrapped-looking line\nnext\tcolumn\n',
    '雪 😀\ntrailing spaces  ',
    'a'.repeat(1024 * 1024),
  ]) {
    const before = Bun.spawnSync(['tmux', '-L', socket, 'display-message', '-p', '#{pane_id}:#{pane_pid}:#{pane_input_off}']);
    const bytes = new TextEncoder().encode(content);
    expect(await tmux.loadClipboard(content)).toBe(bytes.byteLength);
    expect(await tmux.readClipboard()).toEqual(bytes);
    const after = Bun.spawnSync(['tmux', '-L', socket, 'display-message', '-p', '#{pane_id}:#{pane_pid}:#{pane_input_off}']);
    expect(after.stdout).toEqual(before.stdout);
  }
});

test('real tmux read aborts an oversized buffer', async () => {
  const oversized = new Uint8Array((1024 * 1024) + 1).fill(0x61);
  const loaded = Bun.spawn(['tmux', '-L', socket, 'load-buffer', '-b', 'tx-clipboard', '-'], { stdin: 'pipe' });
  loaded.stdin.write(oversized);
  loaded.stdin.end();
  expect(await loaded.exited).toBe(0);
  const tmux = new RealTmux(socket, { audit: () => {} });
  await expect(tmux.readClipboard()).rejects.toThrow('exceeds 1 MiB');
});
