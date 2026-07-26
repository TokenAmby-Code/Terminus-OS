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

type Pane = { seat: string; width: number; height: number; left: number; top: number };

function expectRatio(actual: number, total: number, min: number, max: number): void {
  expect(actual / total).toBeGreaterThanOrEqual(min);
  expect(actual / total).toBeLessThanOrEqual(max);
}

async function constructAt(width: number, height: number): Promise<Record<'palace' | 'somnium' | 'council', Pane[]>> {
  const socket = `txd-geometry-${process.pid}-${width}x${height}`;
  sockets.push(socket);
  await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
  await new RealTmux(socket).ensureEstate();

  const result = {} as Record<'palace' | 'somnium' | 'council', Pane[]>;
  for (const window of ['palace', 'somnium', 'council'] as const) {
    await tmux(socket, 'resize-window', '-t', `main:${window}`, '-x', String(width), '-y', String(height));
    const rows = await tmux(
      socket, 'list-panes', '-t', `main:${window}`, '-F', '#{@canonical_id}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}',
    );
    result[window] = rows.split('\n').map((row) => {
      const [seat = '', paneWidth = '', paneHeight = '', left = '', top = ''] = row.split('\t');
      return { seat, width: Number(paneWidth), height: Number(paneHeight), left: Number(left), top: Number(top) };
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
      expect(geometry.council.map(({ seat }) => seat).sort()).toEqual([...TXD_WINDOWS.council].sort());

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

      const council = Object.fromEntries(geometry.council.map((pane) => [pane.seat, pane]));
      const north = Math.min(...geometry.council.map((pane) => pane.top));
      expect(council['council:custodes']).toMatchObject({ left: 0, top: north });
      expect(council['council:fabricator-general']!.left).toBe(0);
      expect(council['council:fabricator-general']!.top).toBeGreaterThan(0);
      expect(council['council:pax']!.left).toBeGreaterThan(0);
      expect(council['council:pax']!.top).toBe(north);
      expect(council['council:orchestrator']!.left).toBeGreaterThan(0);
      expect(council['council:orchestrator']!.top).toBeGreaterThan(0);
      for (const pane of geometry.council) {
        expectRatio(pane.width, width, 0.45, 0.52);
        expectRatio(pane.height, height, 0.42, 0.52);
      }
    });
  }

  test('canonical labels in a foreign Council split are not accepted as canonical geometry', async () => {
    const socket = `txd-geometry-foreign-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    await tmux(socket, 'select-layout', '-t', 'main:council', 'even-horizontal');

    expect(await adapter.estateGeneration()).toBe('recoverable');
    await expect(adapter.ensureEstate()).rejects.toThrow('canonical estate recovery postcondition failed');
  });

  test('recognizes the exact live five-seat Council plus two-seat Mechanicus generation', async () => {
    const socket = `txd-geometry-previous-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();

    const seed = (await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{pane_id}')).split('\n')[0]!;
    await tmux(socket, 'kill-pane', '-a', '-t', seed);
    const councilSeats = [
      'council:custodes', 'council:pax', 'council:malcador',
      'council:true-terminal', 'council:administratum',
    ];
    const councilPanes = [seed];
    for (let index = 1; index < councilSeats.length; index += 1) {
      councilPanes.push(await tmux(socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', seed));
    }
    for (const [index, pane] of councilPanes.entries()) {
      await tmux(socket, 'set-option', '-p', '-t', pane, '@canonical_id', councilSeats[index]!);
    }
    const mechanicus = await tmux(socket, 'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'main', '-n', 'mechanicus');
    const orchestrator = await tmux(socket, 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', mechanicus);
    await tmux(socket, 'set-option', '-p', '-t', mechanicus, '@canonical_id', 'mechanicus:fabricator-general');
    await tmux(socket, 'set-option', '-p', '-t', orchestrator, '@canonical_id', 'mechanicus:orchestrator');

    expect(await adapter.estateGeneration()).toBe('council-mechanicus');
  });

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

  test('page reconstruction restores a deleted terminal and wipes every page process and pane option', async () => {
    const socket = `txd-page-rebuild-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    const before = (await tmux(socket, 'list-panes', '-t', 'main:palace', '-F', '#{pane_pid}')).split('\n');
    await tmux(socket, 'set-option', '-p', '-t', 'main:palace.0', '@scratch', 'must-die');
    await tmux(socket, 'set-option', '-w', '-t', 'main:palace', '@page_scratch', 'must-die');
    await tmux(socket, 'resize-pane', '-Z', '-t', 'main:palace.0');
    await tmux(socket, 'kill-pane', '-t', 'main:palace.3');

    expect(await control.rebuildPage('palace')).toBe(true);

    const rows = await tmux(socket, 'list-panes', '-t', 'main:palace', '-F', '#{@canonical_id}\t#{pane_pid}\t#{@scratch}\t#{pane_dead}');
    const rebuilt = rows.split('\n').map((row) => row.split('\t'));
    expect(rebuilt.map(([seat]) => seat).sort()).toEqual([...TXD_WINDOWS.palace].sort());
    expect(rebuilt.every(([, pid, scratch, dead]) => !before.includes(pid!) && scratch === '' && dead === '0')).toBe(true);
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:palace', '#{window_zoomed_flag}\t#{@page_scratch}')).toBe('0');
  });
});
