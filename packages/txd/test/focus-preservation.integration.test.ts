// Behavioral-pin lane: machine transport must never steal an attached client's
// active tmux window or pane.
import { afterAll, describe, expect, test } from 'bun:test';
import { RealTmux } from '../src/tmux.ts';

const sockets: string[] = [];

function tmux(socket: string, ...args: string[]): string {
  const result = Bun.spawnSync(['tmux', '-L', socket, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function estatePair(label: string): Promise<{
  socket: string; control: RealTmux; foreground: string; target: string;
}> {
  const socket = `tx-focus-preservation-${process.pid}-${label}`;
  sockets.push(socket);
  tmux(socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'main');
  tmux(socket, 'split-window', '-d', '-t', 'main:0');
  const [foreground, target] = tmux(socket, 'list-panes', '-t', 'main:0', '-F', '#{pane_id}').split('\n');
  if (!foreground || !target) throw new Error('two panes required');
  const ready = `focus-composer-${process.pid}-${label}`;
  tmux(socket, 'send-keys', '-t', target, `PS1='> '; tmux -L ${socket} wait-for -S ${ready}`, 'Enter');
  tmux(socket, 'wait-for', ready);
  tmux(socket, 'set-option', '-p', '-t', foreground, '@canonical_id', 'proof:foreground');
  tmux(socket, 'set-option', '-p', '-t', target, '@canonical_id', 'proof:target');
  tmux(socket, 'select-pane', '-t', foreground);
  return { socket, control: new RealTmux(socket), foreground, target };
}

function activePane(socket: string): string {
  return tmux(socket, 'display-message', '-p', '-t', 'main:0', '#{pane_id}');
}

afterAll(() => {
  for (const socket of sockets) Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
});

describe('focus-preserving machine control', () => {
  test('dispatch tinting leaves the client active pane untouched', async () => {
    const { socket, control, foreground } = await estatePair('dispatch');

    expect(activePane(socket)).toBe(foreground);
    expect(await control.setSeatTint('proof:target', '#302800')).toBe(true);
    expect(activePane(socket)).toBe(foreground);
  });

  test('verified comm transport leaves the client active pane untouched', async () => {
    const { socket, control, foreground } = await estatePair('comm');

    expect(activePane(socket)).toBe(foreground);
    expect((await control.sendVerifiedToSeat('proof:target', 'focus-proof', 'true')).verdict).toBe('staged');
    expect(activePane(socket)).toBe(foreground);
  });
});
