// Canonical estate geometry on disposable tmux servers — behavioral-pin lane.

import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { RealTmux } from '../src/tmux.ts';
import { TXD_ESTATE, TXD_WINDOWS } from '../src/estate.ts';

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

async function paneId(socket: string, seat: string): Promise<string> {
  return tmux(socket, 'list-panes', '-a', '-f', `#{==:#{@canonical_id},${seat}}`, '-F', '#{pane_id}');
}

async function paneEnvironment(socket: string, seat: string): Promise<string[]> {
  const pid = await tmux(socket, 'list-panes', '-a', '-f', `#{==:#{@canonical_id},${seat}}`, '-F', '#{pane_pid}');
  expect(pid).toMatch(/^[1-9][0-9]*$/);
  return (await readFile(`/proc/${pid}/environ`))
    .toString()
    .split('\0')
    .filter(Boolean);
}

async function awaitPaneShell(socket: string, seat: string): Promise<void> {
  const pane = await tmux(socket, 'list-panes', '-a', '-f', `#{==:#{@canonical_id},${seat}}`, '-F', '#{pane_id}');
  const channel = `${socket}-${seat.replaceAll(':', '-')}-${crypto.randomUUID()}`;
  await tmux(
    socket,
    'send-keys',
    '-t',
    pane,
    '-l',
    `TMUX= tmux -L ${socket} wait-for -S ${channel}`,
  );
  await tmux(socket, 'send-keys', '-t', pane, 'Enter');
  await tmux(socket, 'wait-for', channel);
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
  test('every canonical pane owns its placement environment and txd restamps it on respawn', async () => {
    const socket = `txd-pane-environment-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket, { machine: 'k12-personal' });
    await control.ensureEstate();

    for (const seat of TXD_ESTATE) {
      expect(await paneEnvironment(socket, seat)).toContain(`PANE_ID=${seat}`);
      expect(await paneEnvironment(socket, seat)).toContain('IMPERIUM_MACHINE=k12-personal');
    }

    expect(await control.reapSeat('palace:W')).toBe(true);
    await awaitPaneShell(socket, 'palace:W');
    expect(await paneEnvironment(socket, 'palace:W')).toContain('PANE_ID=palace:W');
    expect(await paneEnvironment(socket, 'palace:W')).toContain('IMPERIUM_MACHINE=k12-personal');

    expect(await control.rebuildPage('council')).toBe(true);
    for (const seat of TXD_WINDOWS.council) {
      await awaitPaneShell(socket, seat);
      expect(await paneEnvironment(socket, seat)).toContain(`PANE_ID=${seat}`);
      expect(await paneEnvironment(socket, seat)).toContain('IMPERIUM_MACHINE=k12-personal');
    }
  });

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

  test('untagged operator panes are preserved outside estate identity while unknown tagged seats stay foreign', async () => {
    const socket = `txd-geometry-untagged-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    const operator = await tmux(socket, 'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'main', '-n', 'operator');
    const operatorPid = await tmux(socket, 'display-message', '-p', '-t', operator, '#{pane_pid}');

    expect(await adapter.estateGeneration()).toBe('canonical');
    expect(await adapter.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [] });
    expect(await tmux(socket, 'display-message', '-p', '-t', operator, '#{pane_pid}')).toBe(operatorPid);

    await tmux(socket, 'set-option', '-p', '-t', operator, '@canonical_id', 'foreign:operator');
    expect(await adapter.estateGeneration()).toBe('foreign');
  });

  // Recovery enforces; it does not balk. Drift that `estateGeneration` itself
  // classifies as `recoverable` must be driven back to canonical shape. The
  // 2026-07-26/27 outage was exactly this contradiction: a drifted Council was
  // called recoverable, never repaired — the repair trigger read seat liveness
  // while the acceptance predicate also read geometry — and then rejected,
  // taking the control plane down every two seconds for fifteen minutes.
  test('a drifted Council layout is driven back to canonical instead of failing recovery', async () => {
    const socket = `txd-geometry-layout-drift-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    const before = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));

    await tmux(socket, 'select-layout', '-t', 'main:council', 'even-horizontal');
    expect(await adapter.estateGeneration()).toBe('recoverable');

    expect(await adapter.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: ['council'] });
    expect(await adapter.estateGeneration()).toBe('canonical');

    // Structural drift earns the destructive rebuild, and only on its own page.
    const after = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));
    for (const seat of TXD_WINDOWS.council) expect(after.get(seat)).not.toBe(before.get(seat));
    for (const seat of Object.values(TXD_WINDOWS).flat().filter((seat) => !seat.startsWith('council:'))) {
      expect(after.get(seat)).toBe(before.get(seat));
    }
  });

  // A zoomed pane is the right process in the right place wearing the wrong
  // geometry. Enforcement escalates: display-only drift is corrected in place,
  // so an operator zoom can never cost the Council its running agents.
  test('a zoomed Council is un-zoomed in place without replacing a single pane process', async () => {
    const socket = `txd-geometry-zoom-drift-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    const before = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));

    await tmux(socket, 'resize-pane', '-Z', '-t', 'main:council.0');
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{window_zoomed_flag}')).toBe('1');
    expect(await adapter.estateGeneration()).toBe('recoverable');

    expect(await adapter.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [] });
    expect(await adapter.estateGeneration()).toBe('canonical');
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{window_zoomed_flag}')).toBe('0');

    const after = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));
    for (const [seat, pid] of before) expect(after.get(seat)).toBe(pid);
  });

  // Enforcement that provably cannot converge still fails — once, and loud, and
  // naming the page and the exact divergence, so the operator has something to
  // act on instead of an anonymous postcondition and a restart loop.
  test('an estate that cannot be driven to canonical names the page and the exact divergence', async () => {
    const socket = `txd-geometry-unconvergeable-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    await tmux(socket, 'select-layout', '-t', 'main:council', 'even-horizontal');
    // Reconstruction respawns every page pane from default-shell; a shell that
    // exits immediately makes the repair provably impossible to complete.
    await tmux(socket, 'set-option', '-g', 'default-shell', '/bin/false');

    const failure = await adapter.ensureEstate().then(
      (result) => { throw new Error(`recovery unexpectedly converged: ${JSON.stringify(result)}`); },
      (error: unknown) => String(error),
    );
    expect(failure).toContain('council');
    expect(failure).toMatch(/txd could not drive canonical page council to canonical shape:/);
    expect(failure).not.toMatch(/canonical estate recovery postcondition failed/);
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
    await tmux(socket, 'select-pane', '-t', 'main:palace.0', '-P', 'bg=#302800');
    await tmux(socket, 'resize-pane', '-Z', '-t', 'main:palace.0');
    // A reconstructed seed must not inherit its prior workload command. Static
    // Council panes otherwise replay a stale wrapper launch before txd can
    // retire the old identity and reserve a fresh handshake.
    await tmux(socket, 'respawn-pane', '-k', '-t', 'main:palace.0', 'sleep 600');
    await tmux(socket, 'kill-pane', '-t', 'main:palace.3');

    expect(await control.rebuildPage('palace')).toBe(true);

    const defaultShell = await tmux(socket, 'show-options', '-gv', 'default-shell');
    const rows = await tmux(
      socket,
      'list-panes',
      '-t',
      'main:palace',
      '-F',
      '#{@canonical_id}\t#{pane_pid}\t#{@scratch}\t#{pane_dead}\t#{pane_start_command}',
    );
    const rebuilt = rows.split('\n').map((row) => row.split('\t'));
    expect(rebuilt.map(([seat]) => seat).sort()).toEqual([...TXD_WINDOWS.palace].sort());
    expect(rebuilt.every(([, pid, scratch, dead]) => !before.includes(pid!) && scratch === '' && dead === '0')).toBe(true);
    expect(rebuilt.find(([seat]) => seat === 'palace:W')?.[4]).toBe(
      `/usr/bin/env PANE_ID=palace:W ${defaultShell}`,
    );
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:palace', '#{window_zoomed_flag}\t#{@page_scratch}')).toBe('0');
    for (const seat of TXD_WINDOWS.palace) expect(await control.seatTint(seat)).toBeNull();
  });

  test('Council reconstruction replaces all four Council processes, clears tint, and preserves every other process', async () => {
    const socket = `txd-council-rebuild-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    expect(await control.setSeatTint('council:custodes', '#302800')).toBe(true);
    expect(await control.setSeatTint('council:fabricator-general', '#300808')).toBe(true);

    const before = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));

    expect(await control.rebuildPage('council')).toBe(true);

    const after = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));
    for (const seat of TXD_WINDOWS.council) {
      expect(after.get(seat)).not.toBe(before.get(seat));
      expect(await control.seatTint(seat)).toBeNull();
    }
    for (const seat of Object.values(TXD_WINDOWS).flat().filter((seat) => !seat.startsWith('council:'))) {
      expect(after.get(seat)).toBe(before.get(seat));
    }
  });

  test('a raw kill-pane is repaired as one seat: siblings keep their processes and the page keeps its border', async () => {
    const socket = `txd-kill-repair-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket, { machine: 'k12-personal' });
    await control.ensureEstate();

    const before = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));

    await tmux(socket, 'kill-pane', '-t', await paneId(socket, 'palace:E'));
    expect(await control.resetSeat('palace:E')).toBe(true);

    const after = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect(after.get('palace:E')).not.toBe(before.get('palace:E'));
    for (const seat of Object.values(TXD_WINDOWS).flat().filter((seat) => seat !== 'palace:E')) {
      expect(after.get(seat)).toBe(before.get(seat));
    }
    expect(await paneEnvironment(socket, 'palace:E')).toContain('PANE_ID=palace:E');
    expect(await control.seatTint('palace:E')).toBeNull();
  });

  test('a killed Council quadrant is repaired back to its exact quadrant geometry', async () => {
    const socket = `txd-council-repair-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '160', '-y', '48');

    await tmux(socket, 'kill-pane', '-t', await paneId(socket, 'council:pax'));
    expect(await control.resetSeat('council:pax')).toBe(true);

    const rows = await tmux(
      socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_width}\t#{pane_height}',
    );
    const panes = rows.split('\n').map((row) => row.split('\t'));
    expect(panes.map(([seat]) => seat).sort()).toEqual([...TXD_WINDOWS.council].sort());
    for (const [, width, height] of panes) {
      expectRatio(Number(width), 160, 0.45, 0.55);
      expectRatio(Number(height), 48, 0.45, 0.55);
    }
  });

  test('seat repair refuses when the page window itself is gone', async () => {
    const socket = `txd-window-gone-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();

    await tmux(socket, 'kill-window', '-t', 'main:palace');
    expect(await control.resetSeat('palace:E')).toBe(false);
  });
});
