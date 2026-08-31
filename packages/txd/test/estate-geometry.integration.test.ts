// Canonical estate geometry on disposable tmux servers — behavioral-pin lane.

import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { RealTmux } from '../src/tmux.ts';
import { COUNCIL_GEOMETRY, TXD_ESTATE, TXD_WINDOWS } from '../src/estate.ts';

const conf = new URL('../tmux/tx.conf', import.meta.url).pathname;
const reflowCouncil = new URL('../tmux/reflow-council', import.meta.url).pathname;
const sockets: string[] = [];

async function tmux(socket: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['tmux', '-L', socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`disposable tmux command failed: ${args[0]}: ${stderr.trim()}`);
  // tx.conf correctly points live servers at the installed generation. These
  // source-tree fixtures must keep their disposable hooks on the candidate
  // script or an older installed reflow can mutate the test server.
  if (args.includes('start-server')) {
    const hooks: Array<[string, string]> = [
      ['client-resized', `run-shell -b "${reflowCouncil} client-resized"`],
      ['after-resize-pane', `run-shell -b "${reflowCouncil} after-resize-pane #{window_zoomed_flag}"`],
    ];
    for (const [hook, command] of hooks) {
      const installed = Bun.spawn(['tmux', '-L', socket, 'set-hook', '-g', hook, command], {
        stdout: 'ignore', stderr: 'pipe',
      });
      const [hookStderr, hookCode] = await Promise.all([new Response(installed.stderr).text(), installed.exited]);
      if (hookCode !== 0) throw new Error(`disposable tmux hook install failed: ${hook}: ${hookStderr.trim()}`);
    }
  }
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

async function paneLayoutHeights(socket: string, page: string): Promise<Record<string, number>> {
  const layout = await tmux(socket, 'display-message', '-p', '-t', `main:${page}`, '#{window_layout}');
  const heights = new Map([...layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)]
    .map((match) => [`%${match[5]}`, Number(match[2])]));
  const rows = await tmux(socket, 'list-panes', '-t', `main:${page}`, '-F', '#{@canonical_id}\t#{pane_id}');
  return Object.fromEntries(rows.split('\n').map((row) => {
    const [seat = '', pane = ''] = row.split('\t');
    const height = heights.get(pane);
    if (height === undefined) throw new Error(`layout omitted ${seat}: ${layout}`);
    return [seat, height];
  }));
}

async function paneLayout(socket: string, page: string): Promise<Record<string, Pane>> {
  const layout = await tmux(socket, 'display-message', '-p', '-t', `main:${page}`, '#{window_layout}');
  const geometry = new Map([...layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)]
    .map((match) => [`%${match[5]}`, {
      width: Number(match[1]),
      height: Number(match[2]),
      left: Number(match[3]),
      top: Number(match[4]),
    }]));
  const rows = await tmux(socket, 'list-panes', '-t', `main:${page}`, '-F', '#{@canonical_id}\t#{pane_id}');
  return Object.fromEntries(rows.split('\n').map((row) => {
    const [seat = '', pane = ''] = row.split('\t');
    const observed = geometry.get(pane);
    if (!observed) throw new Error(`layout omitted ${seat}: ${layout}`);
    return [seat, { seat, ...observed }];
  }));
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
  const control = new RealTmux(socket);
  await control.ensureEstate();

  const result = {} as Record<'palace' | 'somnium' | 'council', Pane[]>;
  for (const window of ['palace', 'somnium', 'council'] as const) {
    await tmux(socket, 'resize-window', '-t', `main:${window}`, '-x', String(width), '-y', String(height));
    // Rebuild Council at the projected terminal dimensions. tmux layout trees
    // retain absolute split sizes across a detached resize; txd's owned
    // default is the geometry it constructs at the real attached window size.
    if (window === 'council') await control.rebuildPage(window);
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
  test('fresh construction pins mitosis pages at windows 0, 4, and 5', async () => {
    const socket = `txd-window-order-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    await new RealTmux(socket).ensureEstate();

    const windows = await tmux(socket, 'list-windows', '-t', 'main', '-F', '#{window_index}:#{window_name}');
    expect(windows.split('\n')).toEqual([
      '0:mechanicus',
      '1:palace',
      '2:somnium',
      '3:council',
      '4:palace_fleet',
      '5:somnium_fleet',
    ]);
  });

  test('council rebuild accepts its own construction at the live cockpit size', async () => {
    // 106x79 is the size the k12-personal cockpit actually runs. At height 79
    // the 78 usable rows divide exactly to 52/26. Constructor and acceptance
    // must derive those rows from the same declaration; disagreement on a boot
    // recovery is a crash loop, not merely a red check.
    const socket = `txd-council-cockpit-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '106', '-y', '79');
    expect(await control.rebuildPage('council')).toBe(true);
  });

  test('81x66 Council construction and acceptance agree on stacked two-thirds pairs', async () => {
    const socket = `txd-council-81x66-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '66');
    expect(await control.rebuildPage('council')).toBe(true);

    expect(await paneLayoutHeights(socket, 'council')).toEqual({
      'council:custodes': 21,
      'council:fabricator-general': 11,
      'council:pax': 21,
      'council:orchestrator': 10,
    });
    expect(await control.estateDivergences()).toEqual([]);
  });

  test('Council acceptance rejects the next integer outside two-thirds rounding', async () => {
    const socket = `txd-council-rounding-boundary-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '66');
    expect(await control.rebuildPage('council')).toBe(true);

    await tmux(socket, 'resize-pane', '-D', '-t', await paneId(socket, 'council:custodes'), '1');
    await tmux(socket, 'resize-pane', '-D', '-t', await paneId(socket, 'council:pax'), '1');
    expect(await control.estateDivergences()).toMatchObject([{
      page: 'council',
      clause: 'geometry',
    }]);
  });

  test('191x37 observed client dimensions select the canonical two-column Council without drift', async () => {
    const socket = `txd-council-wide-observed-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();

    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '191', '-y', '37');
    await tmux(socket, 'run-shell', `${reflowCouncil} client-resized`);

    const council = await paneLayout(socket, 'council');
    expect(council['council:custodes']).toMatchObject({ left: 0, top: 0, height: 24 });
    expect(council['council:fabricator-general']).toMatchObject({ left: 0, top: 25, height: 12 });
    expect(council['council:pax']!.left).toBeGreaterThan(0);
    expect(council['council:pax']).toMatchObject({ top: 0, height: 24 });
    expect(council['council:orchestrator']).toMatchObject({ left: council['council:pax']!.left, top: 25, height: 12 });
    expect(await control.estateDivergences()).toEqual([]);
  });

  test('phone-width observed dimensions select the canonical single-column Council without drift', async () => {
    const socket = `txd-council-phone-observed-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();

    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '120', '-y', '72');
    await tmux(socket, 'run-shell', `${reflowCouncil} client-resized`);

    const council = await paneLayout(socket, 'council');
    const physical = ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'];
    expect(physical.map((seat) => council[seat]!.top)).toEqual([0, 24, 37, 61]);
    expect(physical.map((seat) => council[seat]!.height)).toEqual([23, 12, 23, 11]);
    expect(physical.map((seat) => council[seat]!.left)).toEqual([0, 0, 0, 0]);
    expect(physical.map((seat) => council[seat]!.width)).toEqual([120, 120, 120, 120]);
    expect(await control.estateDivergences()).toEqual([]);
  });

  test('current narrow dimensions with wrong Council proportions report geometry drift', async () => {
    const socket = `txd-council-phone-proportion-drift-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '120', '-y', '72');
    await tmux(socket, 'run-shell', `${reflowCouncil} client-resized`);

    await tmux(socket, 'resize-pane', '-D', '-t', await paneId(socket, 'council:custodes'), '1');
    expect(await control.estateDivergences()).toMatchObject([{ page: 'council', clause: 'geometry' }]);
  });

  test('wide to narrow to wide client resize re-derives Council shape without page-drift contradictions', async () => {
    const socket = `txd-council-responsive-sequence-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    const { MemoryEventStore } = await import('../src/store.ts');
    const { Daemon } = await import('../src/core.ts');
    const store = new MemoryEventStore();
    const daemon = new Daemon(store, control);
    await daemon.constructEstate();
    const before = await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}');

    for (const [width, height, expectedColumns] of [[191, 37, 2], [120, 72, 1], [191, 37, 2]] as const) {
      await tmux(socket, 'resize-window', '-t', 'main:council', '-x', String(width), '-y', String(height));
      await tmux(socket, 'run-shell', `${reflowCouncil} client-resized`);
      const council = Object.values(await paneLayout(socket, 'council'));
      expect(new Set(council.map((pane) => pane.left)).size).toBe(expectedColumns);
      expect(await control.estateDivergences()).toEqual([]);
      await daemon.reconcile();
    }

    expect((await store.readAll()).filter((event) =>
      event.event_type === 'reg.contradiction_flagged' && event.payload.kind === 'page_drift')).toEqual([]);
    expect(await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}')).toBe(before);
  });

  test('a small-client window resize preserves Council two-thirds geometry and pane processes', async () => {
    const socket = `txd-council-small-client-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '66');
    expect(await control.rebuildPage('council')).toBe(true);
    const before = await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}');

    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '24');
    await tmux(socket, 'run-shell', reflowCouncil);

    expect(await paneLayoutHeights(socket, 'council')).toEqual({
      'council:custodes': 7,
      'council:fabricator-general': 4,
      'council:pax': 7,
      'council:orchestrator': 3,
    });
    expect(await control.estateDivergences()).toEqual([]);
    expect(await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}')).toBe(before);
  });

  test('a client resize preserves Council zoom and applies deferred two-thirds geometry after unzoom', async () => {
    const socket = `txd-council-zoomed-client-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '66');
    expect(await control.rebuildPage('council')).toBe(true);
    const before = await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}');
    await tmux(socket, 'resize-pane', '-Z', '-t', await paneId(socket, 'council:custodes'));
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '24');
    await tmux(socket, 'run-shell', `${reflowCouncil} client-resized`);

    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{window_zoomed_flag}')).toBe('1');
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{@txd_council_reflow_pending}')).toBe('1');

    await tmux(socket, 'resize-pane', '-Z', '-t', await paneId(socket, 'council:custodes'));
    // The installed after-resize-pane hook dispatches this exact drain in the
    // background so the hook never recursively blocks tmux. Invoke the same
    // event consumer synchronously here to make completion deterministic.
    await tmux(socket, 'run-shell', `${reflowCouncil} after-resize-pane 0`);
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{window_zoomed_flag}')).toBe('0');
    expect(await tmux(socket, 'display-message', '-p', '-t', 'main:council', '#{@txd_council_reflow_pending}')).toBe('');
    expect(await paneLayoutHeights(socket, 'council')).toEqual({
      'council:custodes': 7,
      'council:fabricator-general': 4,
      'council:pax': 7,
      'council:orchestrator': 3,
    });
    expect(await control.estateDivergences()).toEqual([]);
    expect(await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}')).toBe(before);
  });

  test('boot reprojects a small-client Council without replacing pane processes', async () => {
    const socket = `txd-council-small-client-boot-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '66');
    expect(await control.rebuildPage('council')).toBe(true);
    const before = await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}');
    await tmux(socket, 'resize-window', '-t', 'main:council', '-x', '81', '-y', '24');

    expect(await control.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [], diverged_pages: [] });
    expect(await paneLayoutHeights(socket, 'council')).toEqual({
      'council:custodes': 7,
      'council:fabricator-general': 4,
      'council:pax': 7,
      'council:orchestrator': 3,
    });
    expect(await tmux(socket, 'list-panes', '-t', 'main:council', '-F', '#{@canonical_id}\t#{pane_pid}')).toBe(before);
  });

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
    ['narrow', 80, 48],
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
        for (const pane of panes) {
          const minimum = pane.seat === 'council:fabricator-general' || pane.seat === 'council:orchestrator' ? 6 : 9;
          expect(pane.height).toBeGreaterThanOrEqual(minimum);
        }
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
      const stacked = width < (2 * COUNCIL_GEOMETRY.pane.minimumUsableColumns) + COUNCIL_GEOMETRY.verticalBorders;
      if (stacked) {
        expect(geometry.council.every((pane) => pane.left === 0 && pane.width === width)).toBe(true);
        expect(geometry.council.map((pane) => pane.top)).toEqual([...geometry.council.map((pane) => pane.top)].sort((a, b) => a - b));
      } else {
        expect(council['council:fabricator-general']!.left).toBe(0);
        expect(council['council:pax']!.left).toBeGreaterThan(0);
        expect(council['council:pax']!.top).toBe(north);
        expect(council['council:orchestrator']!.left).toBeGreaterThan(0);
        for (const pane of geometry.council) expectRatio(pane.width, width, 0.45, 0.52);
      }
      const westContentHeight = council['council:custodes']!.height + council['council:fabricator-general']!.height;
      const eastContentHeight = council['council:pax']!.height + council['council:orchestrator']!.height;
      expectRatio(council['council:custodes']!.height, westContentHeight, 0.60, 0.70);
      expectRatio(council['council:pax']!.height, eastContentHeight, 0.60, 0.70);
      expectRatio(council['council:fabricator-general']!.height, westContentHeight, 0.25, 0.37);
      expectRatio(council['council:orchestrator']!.height, eastContentHeight, 0.25, 0.37);
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
    expect(await adapter.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [], diverged_pages: [] });
    expect(await tmux(socket, 'display-message', '-p', '-t', operator, '#{pane_pid}')).toBe(operatorPid);

    await tmux(socket, 'set-option', '-p', '-t', operator, '@canonical_id', 'foreign:operator');
    expect(await adapter.estateGeneration()).toBe('foreign');
  });

  // Recovery observes; it does not balk and it does not close a live pane.
  // Drift that `estateGeneration` classifies as `recoverable` on a page that
  // still holds live tagged panes is REPORTED with the clause it fails, never
  // rebuilt over the people on it (Emperor ruling, 2026-08-25: closing panes
  // is the sensitive operation, a restart is not). The 2026-07-26/27 crash
  // loop — a drifted Council called recoverable, never repaired, then fatal
  // every two seconds — is prevented by this call converging instead of
  // throwing; the drift itself is red on health until an operator verb
  // repairs it.
  test('a drifted Council layout holding live panes is reported, not rebuilt, and recovery converges', async () => {
    const socket = `txd-geometry-layout-drift-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    const before = await tmux(socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}');

    await tmux(socket, 'select-layout', '-t', 'main:council', 'even-horizontal');
    expect(await adapter.estateGeneration()).toBe('recoverable');

    expect(await adapter.ensureEstate()).toEqual({
      state: 'existing',
      rebuilt_pages: [],
      diverged_pages: [{ page: 'council', clause: 'geometry', detail: expect.stringContaining('council:custodes@') }],
    });
    expect(await adapter.estateDivergences()).toMatchObject([{ page: 'council', clause: 'geometry' }]);
    expect(await adapter.estateGeneration()).toBe('recoverable');
    expect(await tmux(socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}')).toBe(before);
  });

  // A page nobody occupies is the one class recovery reconstructs; a
  // reconstruction that provably cannot converge still fails — once, loud,
  // naming the page and the exact divergence.
  test('a Council with no live tagged pane is rebuilt, and an impossible rebuild names the page', async () => {
    const socket = `txd-geometry-unconvergeable-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const adapter = new RealTmux(socket);
    await adapter.ensureEstate();
    const before = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));

    await tmux(socket, 'kill-window', '-t', 'main:council');
    expect(await adapter.estateGeneration()).toBe('recoverable');
    expect(await adapter.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: ['council'], diverged_pages: [] });
    expect(await adapter.estateGeneration()).toBe('canonical');
    const after = new Map((await tmux(
      socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}',
    )).split('\n').map((row) => row.split('\t') as [string, string]));
    for (const seat of Object.values(TXD_WINDOWS).flat().filter((seat) => !seat.startsWith('council:'))) {
      expect(after.get(seat)).toBe(before.get(seat));
    }

    await tmux(socket, 'kill-window', '-t', 'main:council');
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
    for (const [, width] of panes) {
      expectRatio(Number(width), 160, 0.45, 0.55);
    }
    const bySeat = new Map(panes.map(([seat, , height]) => [seat!, Number(height)]));
    expectRatio(bySeat.get('council:custodes')!, 48, 0.60, 0.70);
    expectRatio(bySeat.get('council:pax')!, 48, 0.60, 0.70);
    expectRatio(bySeat.get('council:fabricator-general')!, 48, 0.25, 0.36);
    expectRatio(bySeat.get('council:orchestrator')!, 48, 0.25, 0.36);
  });

  test('estate work leaves the operator zoom exactly where the operator put it', async () => {
    // Expansion is the operator's, and the same invariant focus already holds
    // (`focus-preservation.integration.test.ts`) applies to it: txd moves it on
    // an explicit request and never as a side effect of tidying the estate.
    //
    // tmux reports a zoomed pane at the full window size and leaves its
    // siblings on their real coordinates, so a page read through `pane_left`
    // looks like a page whose panes disagree about their own window. Reading
    // the estate that way made an operator's zoom indistinguishable from an
    // estate coming apart, which is what drove the zoom-destroying repairs
    // this pin now forbids.
    const socket = `txd-zoom-canonical-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    const store = new (await import('../src/store.ts')).MemoryEventStore();
    const daemon = new (await import('../src/core.ts')).Daemon(store, control);
    await daemon.constructEstate();
    expect(await control.estateGeneration()).toBe('canonical');

    const zoomed = async (): Promise<string> =>
      tmux(socket, 'display', '-p', '-t', 'main:=council', '#{window_zoomed_flag}');
    const pids = async (): Promise<string> =>
      tmux(socket, 'list-panes', '-a', '-F', '#{@canonical_id}\t#{pane_pid}');

    for (const seat of TXD_WINDOWS.council) {
      await tmux(socket, 'resize-pane', '-Z', '-t', await paneId(socket, seat));
      expect(await zoomed()).toBe('1');
      const before = await pids();

      // Neither the estate ensure that runs at every boot nor an explicit
      // reconcile is a request to change what the operator is looking at.
      expect(await control.estateGeneration()).toBe('canonical');
      expect(await control.ensureEstate()).toEqual({ state: 'existing', rebuilt_pages: [], diverged_pages: [] });
      expect(await zoomed()).toBe('1');

      await daemon.reconcile();
      expect(await zoomed()).toBe('1');
      expect(await control.estateGeneration()).toBe('canonical');
      expect(await pids()).toBe(before);

      await tmux(socket, 'resize-pane', '-Z', '-t', await paneId(socket, seat));
    }
    expect(await zoomed()).toBe('0');
    expect(await control.estateGeneration()).toBe('canonical');
  });

  test('a genuinely diverged page is still refused while a page is zoomed', async () => {
    // The zoom-independent read must not become blanket forgiveness: with a
    // council pane zoomed, a seat killed out of another page is still the
    // estate diverging and still has to be seen.
    const socket = `txd-zoom-divergence-${process.pid}`;
    sockets.push(socket);
    await tmux(socket, '-f', conf, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off');
    const control = new RealTmux(socket);
    await control.ensureEstate();

    await tmux(socket, 'resize-pane', '-Z', '-t', await paneId(socket, 'council:pax'));
    await tmux(socket, 'kill-pane', '-t', await paneId(socket, 'palace:E'));

    expect(await control.estateGeneration()).toBe('recoverable');
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
