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

  test('contains native navigation and copy-mode traps', () => {
    for (const binding of [
      'bind h select-pane -L', 'bind j select-pane -D', 'bind k select-pane -U', 'bind l select-pane -R',
      'bind -r H resize-pane -L 5', 'bind -r J resize-pane -D 3',
      'bind -r K resize-pane -U 3', 'bind -r L resize-pane -R 5',
      'bind -n C-k copy-mode -u', 'unbind -T copy-mode g', 'unbind -T copy-mode f',
      'unbind -T copy-mode F', 'unbind -T copy-mode t', 'unbind -T copy-mode T',
      'unbind -T copy-mode \\;', 'unbind -T copy-mode ,',
    ]) expect(conf).toContain(binding);
  });

  test('wheel scrolling targets only the active pane with native tmux commands', () => {
    const wheel = conf.slice(conf.indexOf('%if '), conf.indexOf('%else\ndisplay-message'));

    expect(wheel).toContain("#{P:#{?pane_active,#{pane_in_mode},}}");
    expect(wheel).toContain("-t '#{P:#{?pane_active,#{pane_id},}}'");
    expect(wheel).not.toMatch(/mouse_(?:pane|any_flag)/i);
    expect(wheel.match(/run-shell -C/g)).toHaveLength(3);
    expect(wheel).not.toMatch(/run-shell(?! -C)/);
    expect(wheel).toContain('copy-mode -e');
    expect(wheel).toContain('send-keys');
    expect(wheel).toContain('scroll-up');
    expect(wheel).toContain('scroll-down');
  });

  test('wheel scrolling silently no-ops at both copy-mode boundaries', () => {
    const supportedVersionBindings = conf.slice(conf.indexOf('%if '), conf.indexOf('%else\n'));
    expect(conf).toContain('copy-mode -e');
    expect(conf).toContain('send-keys -t \'#{P:#{?pane_active,#{pane_id},}}\' -X -N 3 scroll-up');
    expect(conf).toContain(`bind -n WheelDownPane if-shell -F '#{P:#{?pane_active,#{pane_in_mode},}}' {
  run-shell -C "send-keys -t '#{P:#{?pane_active,#{pane_id},}}' -X -N 3 scroll-down"
} {}`);
    expect(supportedVersionBindings).not.toContain('display-message');
    for (const line of supportedVersionBindings.split('\n').filter((candidate) => candidate.includes('run-shell'))) {
      expect(line.trim().startsWith('run-shell -C ')).toBe(true);
    }
  });

  test('excludes retired tmuxctld and popup policy', () => {
    for (const retired of [
      'tmuxctld-ping', 'bind -n Any', 'tmux-plan-menu', 'tmux-legion-prompt-popup',
      'tmux-mark-for-close', 'tmux-grid-expand', 'remain-on-exit', 'pane-died',
      'client-lease', '@PERSONA', '@SESSION_DOC', 'goto-spoken',
    ]) expect(conf).not.toContain(retired);
  });
});
