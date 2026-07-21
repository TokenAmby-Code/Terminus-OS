// Canonical tx tmux configuration — behavioral-pin lane.

import { describe, expect, test } from 'bun:test';

const conf = await Bun.file(new URL('../tmux/tx.conf', import.meta.url)).text();

describe('tmux/tx.conf', () => {
  test('pins canonical indexing, prefix, terminal, and reload path', () => {
    expect(conf).toContain('set -g prefix C-Space');
    expect(conf).toContain('unbind C-b');
    expect(conf).toContain('bind C-Space send-prefix');
    expect(conf).toContain('bind Escape { }');
    expect(conf).toContain('set -g default-terminal "tmux-256color"');
    expect(conf).toContain('set -g base-index 0');
    expect(conf).toContain('setw -g pane-base-index 0');
    expect(conf).toContain('bind r source-file ~/runtimes/Terminus-OS/live/packages/txd/tmux/tx.conf');
  });

  test('contains native navigation, copy-mode traps, and tmux 3.4 wheel scrolling', () => {
    for (const binding of [
      'bind h select-pane -L', 'bind j select-pane -D', 'bind k select-pane -U', 'bind l select-pane -R',
      'bind -r H resize-pane -L 5', 'bind -r J resize-pane -D 3',
      'bind -r K resize-pane -U 3', 'bind -r L resize-pane -R 5',
      'bind -n C-k copy-mode -u', 'unbind -T copy-mode g', 'unbind -T copy-mode f',
      'unbind -T copy-mode F', 'unbind -T copy-mode t', 'unbind -T copy-mode T',
      'unbind -T copy-mode \\;', 'unbind -T copy-mode ,', 'run-shell -C',
    ]) expect(conf).toContain(binding);
  });

  test('excludes retired tmuxctld and popup policy', () => {
    for (const retired of [
      'tmuxctld-ping', 'bind -n Any', 'tmux-plan-menu', 'tmux-legion-prompt-popup',
      'tmux-mark-for-close', 'tmux-grid-expand', 'remain-on-exit', 'pane-died',
      'client-lease', '@PERSONA', '@SESSION_DOC', 'goto-spoken',
    ]) expect(conf).not.toContain(retired);
  });
});
