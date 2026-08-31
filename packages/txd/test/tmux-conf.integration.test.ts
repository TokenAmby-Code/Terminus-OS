// Loaded tmux selection configuration — behavioral-pin integration lane.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RealTmux } from '../src/tmux.ts';

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

test('prefix e toggles zoom exactly like prefix z', () => {
  const binding = new TextDecoder().decode(tmux('list-keys', '-T', 'prefix', 'e').stdout);
  expect(binding).toContain('resize-pane -Z');
  expect(binding).not.toContain('if-shell');
  expect(binding).not.toContain('window_zoomed_flag');
});

test('prefix arrows enter the same Enter-to-zoom table as prefix h/j/k/l', () => {
  const movements: Array<[string, string]> = [
    ['h', 'L'], ['j', 'D'], ['k', 'U'], ['l', 'R'],
    ['Left', 'L'], ['Down', 'D'], ['Up', 'U'], ['Right', 'R'],
  ];
  for (const [key, direction] of movements) {
    const binding = new TextDecoder().decode(tmux('list-keys', '-T', 'prefix', key).stdout);
    expect(binding).toContain(`select-pane -${direction}`);
    expect(binding).toContain('switch-client -T pane-select');
  }
  expect(new TextDecoder().decode(tmux('list-keys', '-T', 'pane-select', 'Enter').stdout)).toContain('resize-pane -Z');
});

test('post-resize hooks reflow Council beneath operator zoom', () => {
  expect(new TextDecoder().decode(tmux('show-options', '-g', '-v', 'window-size').stdout).trim()).toBe('latest');
  const resizeHook = new TextDecoder().decode(tmux('show-hooks', '-g', 'window-resized').stdout);
  expect(resizeHook).toContain('packages/txd/tmux/reflow-council');
  expect(resizeHook).toContain('window-resized');

  const layoutHook = new TextDecoder().decode(tmux('show-hooks', '-g', 'window-layout-changed').stdout);
  expect(layoutHook).toContain('packages/txd/tmux/reflow-council');
  expect(layoutHook).toContain('window-layout-changed');
  expect(resizeHook).not.toMatch(/select-layout|even-vertical|tiled/);
  const drain = new TextDecoder().decode(tmux('show-hooks', '-g', 'after-resize-pane').stdout);
  expect(drain).not.toContain('packages/txd/tmux/reflow-council');
});

// The estate hooks only parse under the k12 socket guard, and a server boot
// tolerates config errors that `source-file` refuses — so sourcing the conf
// under the guard is the one load that proves every hook name is one the real
// tmux accepts. Only a tmux carrying the estate's baseline pane hooks ever
// runs the estate, so a tmux without them cannot judge the conf.
const estateCapable = (() => {
  const probeSocket = `tx-conf-cap-${process.pid}`;
  const probe = Bun.spawnSync([
    'tmux', '-f', '/dev/null', '-L', probeSocket,
    'start-server', ';', 'set-hook', '-g', 'pane-exited', 'run-shell true', ';', 'kill-server',
  ]);
  return probe.exitCode === 0;
})();

test.skipIf(!estateCapable)('the k12 estate branch loads through source-file without refusal', () => {
  const estateSocket = `tx-conf-k12-${process.pid}`;
  const env = { ...process.env, TXD_TMUX_SOCKET: 'k12' };
  const estateTmux = (...args: string[]) => Bun.spawnSync(['tmux', '-L', estateSocket, ...args], { env });
  const started = estateTmux('-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '-x', '80', '-y', '12');
  if (started.exitCode !== 0) throw new Error(new TextDecoder().decode(started.stderr));
  try {
    const sourced = estateTmux('source-file', conf);
    expect(new TextDecoder().decode(sourced.stderr)).toBe('');
    expect(sourced.exitCode).toBe(0);
    const hooks = new TextDecoder().decode(estateTmux('show-hooks', '-g').stdout);
    expect(hooks).toMatch(/after-kill-pane\[\d+\][^\n]*pane-killed/);
    expect(hooks).toMatch(/window-unlinked\[\d+\][^\n]*pane-killed/);
    // Command hooks are globally inspectable here; pane-died/pane-exited are
    // separately pinned from the sourced file because tmux omits them from
    // this show-hooks projection on supported 3.6 builds.
    expect(hooks.match(/systemd-cat --identifier=txd-tmux-hook/g)).toHaveLength(2);
  } finally {
    estateTmux('kill-server');
  }
});

test.skipIf(!estateCapable)('txd boot reinstalls lifecycle hooks on a persistent server that lost them', async () => {
  const staleSocket = `tx-conf-stale-${process.pid}`;
  const environment = { ...process.env };
  delete environment.TMUX;
  const staleTmux = (...args: string[]) => Bun.spawnSync(['tmux', '-L', staleSocket, ...args], { env: environment });
  const started = staleTmux('-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '12', 'sleep', '60');
  if (started.exitCode !== 0) throw new Error(new TextDecoder().decode(started.stderr));
  try {
    await new RealTmux(staleSocket).ensureLifecycleHooks();
    const paneDied = new TextDecoder().decode(staleTmux('show-hooks', '-g', 'pane-died').stdout);
    const paneExited = new TextDecoder().decode(staleTmux('show-hooks', '-g', 'pane-exited').stdout);
    expect(paneDied).toMatch(/pane-died\[\d+\][^\n]*tx estate event pane-died/);
    expect(paneExited).toMatch(/pane-exited\[\d+\][^\n]*tx estate event pane-exited/);
    // `tx inspect hooks` reads the txd-tmux-hook journal identifier, so a hook
    // that does not pipe through systemd-cat fires invisibly to the diagnostic.
    expect(paneDied).toContain('2>&1 | systemd-cat --identifier=txd-tmux-hook || true');
    expect(paneExited).toContain('2>&1 | systemd-cat --identifier=txd-tmux-hook || true');
  } finally {
    staleTmux('kill-server');
  }
});

test('copy-pipe -P leaves no automatic buffer behind', () => {
  tmux('delete-buffer', '-b', 'buffer0');
  expect(tmux('copy-mode', '-t', 'main:0.0').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'begin-selection').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'cursor-left').exitCode).toBe(0);
  expect(tmux('send-keys', '-t', 'main:0.0', '-X', 'copy-pipe-and-cancel', '-P', 'true').exitCode).toBe(0);
  expect(new TextDecoder().decode(tmux('list-buffers').stdout)).toBe('');
});
