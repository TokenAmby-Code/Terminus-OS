// Canonical estate geometry on disposable tmux servers — behavioral-pin lane.

import { afterEach, describe, expect, test } from 'bun:test';
import { RealTmux } from '../src/tmux.ts';
import { TXD_WINDOWS } from '../src/estate.ts';

const conf = new URL('../tmux/tx.conf', import.meta.url).pathname;
const sockets: string[] = [];

async function tmux(socket: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['tmux', '-L', socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`disposable tmux command failed: ${args[0]}: ${stderr.trim()}`);
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(async (socket) => {
    const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }));
});

type Pane = { seat: string; width: number; height: number };

function expectRatio(actual: number, total: number, min: number, max: number): void {
  expect(actual / total).toBeGreaterThanOrEqual(min);
  expect(actual / total).toBeLessThanOrEqual(max);
}

async function constructAt(width: number, height: number): Promise<Record<'palace' | 'somnium', Pane[]>> {
  const socket = `txd-geometry-${process.pid}-${width}x${height}`;
  sockets.push(socket);
  await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
  await new RealTmux(socket).ensureEstate();

  const result = {} as Record<'palace' | 'somnium', Pane[]>;
  for (const window of ['palace', 'somnium'] as const) {
    await tmux(socket, 'resize-window', '-t', `main:${window}`, '-x', String(width), '-y', String(height));
    const rows = await tmux(
      socket, 'list-panes', '-t', `main:${window}`, '-F', '#{@canonical_id}\t#{pane_width}\t#{pane_height}',
    );
    result[window] = rows.split('\n').map((row) => {
      const [seat = '', paneWidth = '', paneHeight = ''] = row.split('\t');
      return { seat, width: Number(paneWidth), height: Number(paneHeight) };
    });
  }
  return result;
}

describe('disposable canonical estate geometry', () => {
  for (const [label, width, height] of [
    ['narrow', 80, 24],
    ['normal', 160, 48],
    ['wide', 240, 72],
  ] as const) {
    test(`${label} terminal preserves canonical seats, proportions, and readable panes`, async () => {
      const geometry = await constructAt(width, height);

      expect(geometry.palace.map(({ seat }) => seat).sort()).toEqual([...TXD_WINDOWS.palace].sort());
      expect(geometry.somnium.map(({ seat }) => seat).sort()).toEqual([...TXD_WINDOWS.somnium].sort());

      for (const panes of Object.values(geometry)) {
        expect(Math.min(...panes.map(({ width: paneWidth }) => paneWidth))).toBeGreaterThanOrEqual(16);
        expect(Math.min(...panes.map(({ height: paneHeight }) => paneHeight))).toBeGreaterThanOrEqual(9);
      }

      const palace = Object.fromEntries(geometry.palace.map((pane) => [pane.seat, pane]));
      expectRatio(palace['palace:W']!.width, width, 0.23, 0.32);
      expectRatio(palace['palace:E']!.width, width, 0.25, 0.32);
      expectRatio(palace['palace:N']!.height, height, 0.42, 0.51);
      expectRatio(palace['palace:S']!.height, height, 0.42, 0.51);

      const somnium = Object.fromEntries(geometry.somnium.map((pane) => [pane.seat, pane]));
      expectRatio(somnium['somnium:W']!.width, width, 0.23, 0.32);
      expectRatio(somnium['somnium:N']!.width, width, 0.34, 0.38);
      expectRatio(somnium['somnium:NE']!.width, width, 0.34, 0.38);
      expectRatio(somnium['somnium:N']!.height, height, 0.42, 0.51);
      expectRatio(somnium['somnium:S']!.height, height, 0.42, 0.51);
      expectRatio(somnium['somnium:NE']!.height, height, 0.42, 0.51);
      expectRatio(somnium['somnium:SE']!.height, height, 0.42, 0.51);
    });
  }

  test('starts every canonical estate pane in the user home directory', async () => {
    const socket = `txd-cwd-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    await new RealTmux(socket).ensureEstate();

    const paths = await tmux(socket, 'list-panes', '-a', '-F', '#{pane_current_path}');
    const home = process.env.HOME;
    if (!home) throw new Error('HOME must be set for the pane cwd behavioral pin');
    expect(new Set(paths.split('\n').filter(Boolean))).toEqual(new Set([home]));
  });
});
