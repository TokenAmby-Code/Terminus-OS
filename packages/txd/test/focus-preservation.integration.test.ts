// Behavioral-pin lane: machine transport must never steal an attached client's
// active tmux window or pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { RealTmux } from '../src/tmux.ts';

const socket = `tx-focus-preservation-${process.pid}`;

function tmux(...args: string[]): string {
  const result = Bun.spawnSync(['tmux', '-L', socket, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function estatePair(): Promise<{ control: RealTmux; foreground: string; target: string }> {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'main');
  tmux('split-window', '-d', '-t', 'main:0');
  const [foreground, target] = tmux('list-panes', '-t', 'main:0', '-F', '#{pane_id}').split('\n');
  if (!foreground || !target) throw new Error('two panes required');
  tmux('set-option', '-p', '-t', foreground, '@canonical_id', 'proof:foreground');
  tmux('set-option', '-p', '-t', target, '@canonical_id', 'proof:target');
  tmux('select-pane', '-t', foreground);
  return { control: new RealTmux(socket), foreground, target };
}

function activePane(): string {
  return tmux('display-message', '-p', '-t', 'main:0', '#{pane_id}');
}

afterEach(() => {
  Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
});

describe('focus-preserving machine control', () => {
  test('dispatch tinting leaves the client active pane untouched', async () => {
    const { control, foreground } = await estatePair();

    expect(activePane()).toBe(foreground);
    expect(await control.setSeatTint('proof:target', '#302800')).toBe(true);
    expect(activePane()).toBe(foreground);
  });

  test('verified comm transport leaves the client active pane untouched', async () => {
    const { control, foreground } = await estatePair();

    expect(activePane()).toBe(foreground);
    expect((await control.sendVerifiedToSeat('proof:target', 'focus-proof', 'true')).verdict).toBe('staged');
    expect(activePane()).toBe(foreground);
  });
});
