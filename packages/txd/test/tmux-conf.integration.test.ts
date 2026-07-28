// Loaded tmux selection configuration — behavioral-pin integration lane.

import { afterAll, beforeAll, expect, test } from 'bun:test';

const socket = `tx-conf-test-${process.pid}`;
const conf = new URL('../tmux/tx.conf', import.meta.url).pathname;

function tmux(...args: string[]) {
  return Bun.spawnSync(['tmux', '-L', socket, ...args]);
}

beforeAll(() => {
  const started = tmux('-f', conf, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '12');
  if (started.exitCode !== 0) throw new Error(new TextDecoder().decode(started.stderr));
});

afterAll(() => {
  tmux('kill-server');
});

test('the active table is exact, current-viewport, and release-persistent', () => {
  expect(new TextDecoder().decode(tmux('show-options', '-g', '-v', 'set-clipboard').stdout).trim()).toBe('off');
  expect(new TextDecoder().decode(tmux('list-keys', '-T', 'root', 'C-k').stdout)).not.toContain('copy-mode -u');
  const bindings: Array<[string, string]> = [
    ['Space', 'begin-selection'], ['Left', 'cursor-left'], ['Right', 'cursor-right'],
    ['Up', 'cursor-up'], ['Down', 'cursor-down'], ['C-Left', 'previous-word'],
    ['C-Right', 'next-word'], ['Home', 'start-of-line'], ['End', 'end-of-line'],
    ['PPage', 'page-up'], ['NPage', 'page-down'], ['Tab', 'other-end'],
    ['Escape', 'cancel'],
  ];
  for (const [key, command] of bindings) {
    const active = new TextDecoder().decode(tmux('list-keys', '-T', 'copy-mode', key).stdout);
    expect(active).toContain(command);
    expect(active).not.toMatch(/run-shell|txd|typing.guard|tx-(?:osc52|selection)/);
  }
  expect(tmux('list-keys', '-T', 'copy-mode', 'MouseDragEnd1Pane').exitCode).not.toBe(0);
  const enter = new TextDecoder().decode(tmux('list-keys', '-T', 'copy-mode', 'Enter').stdout);
  expect(enter).toContain('copy-pipe-and-cancel -P');
  expect(enter).toContain('packages/tx/bin/tx-selection');
  expect(enter.match(/tx-selection/g)).toHaveLength(1);

  expect(tmux('copy-mode', '-t', 'main:0.0').exitCode).toBe(0);
  const scroll = new TextDecoder().decode(tmux('display-message', '-p', '-t', 'main:0.0', '#{scroll_position}').stdout).trim();
  expect(scroll).toBe('0');
  tmux('send-keys', '-t', 'main:0.0', '-X', 'cancel');
});

test('copy-pipe -P leaves no automatic buffer behind', () => {
  tmux('delete-buffer', '-b', 'buffer0');
  expect(tmux('copy-mode', '-t', 'main:0.0').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'begin-selection').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'cursor-left').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'copy-pipe-and-cancel', '-P', 'true').exitCode).toBe(0);
  expect(new TextDecoder().decode(tmux('list-buffers').stdout)).toBe('');
});
