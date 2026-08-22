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

  test('contains idempotent pane focus and native pane navigation', () => {
    const paneUx = conf.slice(conf.indexOf('# Pane navigation and expansion.'), conf.indexOf('bind -r H'));

    expect(paneUx).toContain("bind e if -F '#{==:#{window_zoomed_flag},0}' 'resize-pane -Z'");
    expect(paneUx).not.toContain('bind e resize-pane -Z');
    for (const [key, direction] of [['h', 'L'], ['j', 'D'], ['k', 'U'], ['l', 'R']]) {
      expect(paneUx).toContain(`bind ${key} {`);
      expect(paneUx).toContain(`select-pane -${direction}`);
      expect(paneUx).toContain(`bind -T pane-select ${key} {`);
    }
    expect(paneUx).toContain('switch-client -T pane-select');
    expect(paneUx).toContain('bind -T pane-select Enter resize-pane -Z');
    expect(paneUx).toContain('bind -T pane-select Escape display-message "pane-select cancelled"');
    expect(paneUx).toContain('bind -T pane-select q display-message "pane-select cancelled"');
    expect(paneUx).not.toContain('run-shell');
    expect(paneUx).not.toContain('tmuxctld');

    for (const binding of [
      'bind -r H resize-pane -L 5', 'bind -r J resize-pane -D 3',
      'bind -r K resize-pane -U 3', 'bind -r L resize-pane -R 5',
    ]) expect(conf).toContain(binding);
  });

  test('routes bare Shift+Tab through the typed logical mode action', () => {
    const binding = conf.split('\n').find((line) => line.startsWith('bind -n BTab '));
    expect(binding).toContain('#{pane_current_command},claude');
    expect(binding).toContain('#{pane_current_command},codex');
    expect(binding).toContain('$HOME/.bun/bin/bun $HOME/.local/bin/tx mode toggle');
    expect(binding).toContain('--target "#{@canonical_id}"');
    expect(binding).toContain('{ send-keys BTab }');
    expect(binding).not.toMatch(/pane_id|tmuxctld|capture-pane|grep/);
  });

  test('pins the keyboard-first selection table and current-viewport entry', () => {
    const selection = conf.slice(conf.indexOf('# Pane-local selection.'), conf.indexOf('%if '));
    for (const binding of [
      'set -g mode-keys emacs',
      'set -g set-clipboard off',
      'bind -n C-k copy-mode',
      'bind -T copy-mode Space send-keys -X begin-selection',
      'bind -T copy-mode Left send-keys -X cursor-left',
      'bind -T copy-mode Right send-keys -X cursor-right',
      'bind -T copy-mode Up send-keys -X cursor-up',
      'bind -T copy-mode Down send-keys -X cursor-down',
      'bind -T copy-mode C-Left send-keys -X previous-word',
      'bind -T copy-mode C-Right send-keys -X next-word',
      'bind -T copy-mode Home send-keys -X start-of-line',
      'bind -T copy-mode End send-keys -X end-of-line',
      'bind -T copy-mode PPage send-keys -X page-up',
      'bind -T copy-mode NPage send-keys -X page-down',
      'bind -T copy-mode Tab send-keys -X other-end',
      'bind -T copy-mode Escape send-keys -X cancel',
    ]) expect(selection).toContain(binding);
    expect(selection).not.toContain('copy-mode -u');
    const movementLines = selection.split('\n').filter((line) =>
      /copy-mode (?:Space|Left|Right|Up|Down|C-Left|C-Right|Home|End|PPage|NPage|Tab) /.test(line),
    );
    expect(movementLines.join('\n')).not.toMatch(/run-shell|txd|tx-selection|typing.guard/);
  });

  test('keeps mouse selections visible and invokes one thin tx client only on commit', () => {
    const selection = conf.slice(conf.indexOf('# Pane-local selection.'), conf.indexOf('%if '));
    expect(selection).toContain('unbind -T copy-mode MouseDragEnd1Pane');
    expect(selection).toContain('unbind -T copy-mode-vi MouseDragEnd1Pane');
    const enter = selection.split('\n').find((line) => line.startsWith('bind -T copy-mode Enter '));
    expect(enter).toContain('copy-pipe-and-cancel -P');
    expect(enter).toContain('$HOME/.bun/bin/bun $HOME/runtimes/Terminus-OS/live/packages/tx/bin/tx-selection');
    expect(enter).toContain('#{client_tty}');
    expect(selection.match(/tx-selection/g)).toHaveLength(1);
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
      'tmux-mark-for-close', 'tmux-grid-expand',
      'client-lease', '@PERSONA', '@SESSION_DOC', 'goto-spoken',
    ]) expect(conf).not.toContain(retired);
  });

  test('keeps panes observable through exit without owning daemon lifecycle hooks', () => {
    expect(conf).toContain('%if "#{==:#{TXD_TMUX_SOCKET},k12}"');
    expect(conf).toContain('set -g remain-on-exit on');
    const lifecycleHooks = conf.split('\n').filter((line) =>
      line.startsWith('set-hook -g ') && line.includes('tx estate event'),
    );
    expect(lifecycleHooks).toHaveLength(2);
    for (const hook of lifecycleHooks) {
      expect(hook).toContain('systemd-cat --identifier=txd-tmux-hook');
      expect(hook).toContain('2>&1');
      expect(hook).toMatch(/\| systemd-cat .* \|\| true"'$/);
    }
  });

  test('leaves daemon-owned lifecycle hooks untouched on config reload', () => {
    const daemonOwnedHooks = conf.split('\n').filter((line) =>
      /^set-hook -g pane-(?:died|exited)\b/.test(line),
    );

    expect(daemonOwnedHooks).toEqual([]);
  });

  test('observes kill commands the pane hooks never see and forwards them page-less', () => {
    // `kill-pane` fires neither pane-died nor pane-exited, a killed window
    // fires only window-unlinked (tmux 3.6 has no after-kill-window hook),
    // and both hooks run with the ACTIVE window as context — a page claim
    // from the kill site would lie. The forward is therefore page-less.
    expect(conf).toContain('set-hook -g after-kill-pane');
    expect(conf).toContain('set-hook -g window-unlinked');
    expect(conf).not.toContain('after-kill-window');
    const killForwards = conf.split('\n').filter((line) => line.includes('tx estate event pane-killed'));
    expect(killForwards).toHaveLength(2);
    for (const line of killForwards) {
      expect(line).toContain('$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-killed');
      expect(line).not.toContain('--page');
    }
  });
});
