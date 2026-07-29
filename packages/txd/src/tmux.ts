// Authoritative tmux control plane (spec §7 rung 2) + canonical-id membrane.
//
// The daemon owns ONE tmux server (`tmux -L <socket>`). Canonical ids (seat
// names, colons and all) live ONLY in the `@canonical_id` pane option — never
// as a tmux target (a `somnium:NE` session name would collide with tmux's `:`
// target syntax). Everything ABOVE this membrane speaks canonical ids; raw
// `%id`/`@id`/`$id` never crosses upward. Below the membrane we resolve a
// canonical id to its `%id` internally to operate, and discard it.
//
// The interface is injectable so tests run against an in-memory fake with zero
// tmux dependency; on-box acceptance exercises the real plane.

import { TXD_ESTATE, TXD_SESSION, TXD_WINDOWS, type TxdPage } from './estate.ts';
import { open, readFile, readlink } from 'node:fs/promises';
import {
  CLIPBOARD_BUFFER_NAME,
  MAX_CLIPBOARD_BYTES,
  type AgentModeState,
  type ModeTransitionIntent,
  type ModeTransitionMechanism,
} from '@terminus-os/contracts';
import { osc52Sequence, validateAttachedClientTty, validateClipboardBytes } from './osc52.ts';

export type SeatObservation = { seat_id: string; pane: 'live' | 'dead' };
export type SeatWorkload = { seat_id: string; command: string; idle: boolean };
export type EstateEnsureResult = {
  state: 'created' | 'existing';
  rebuilt_pages: TxdPage[];
};
export type EstateGeneration = 'empty' | 'canonical' | 'council-mechanicus' | 'migration-interrupted' | 'recoverable' | 'foreign';
export type StaticAgentLaunch = {
  seatId: string;
  engine: 'claude' | 'codex';
  wrapper: string;
  workspace: string;
  environment: Record<string, string>;
};

// Below-membrane delivery outcome (discriminated by verdict). `partial_delivered`
// = the literal text reached the pane but the submit (Enter) did not — first-class,
// never collapsed to failure. A total failure carries zero bytes by construction.
export type SendOutcome =
  | { verdict: 'delivered'; bytes: number }
  | { verdict: 'partial_delivered'; bytes: number }
  | { verdict: 'failed_none_delivered'; bytes: 0 };

export type AgentModeTransitionOutcome = {
  before: AgentModeState;
  after: AgentModeState;
  changed: boolean;
  verified: boolean;
  mechanism: ModeTransitionMechanism;
};

export interface TmuxControlPlane {
  reachable(): Promise<boolean>;
  version(): Promise<string | null>;
  workloads(): Promise<SeatWorkload[]>;
  killServer(): Promise<boolean>;
  /** Live seats as canonical ids + pane liveness. Never exposes %id. */
  listSeats(): Promise<SeatObservation[]>;
  /** Create/repair the declared estate and report every page whose processes were reconstructed. */
  ensureEstate(): Promise<EstateEnsureResult>;
  /** Classify only exact known generations before any topology mutation. */
  estateGeneration(): Promise<EstateGeneration>;
  /** Execute/resume the one approved Council topology migration. */
  migrateCouncil(pending: boolean): Promise<boolean>;
  /** Create a bare seat: a single-pane session tagged with the canonical id. */
  createSeat(seatId: string): Promise<void>;
  /** Kill the seat's pane (teardown). Idempotent. */
  killSeat(seatId: string): Promise<void>;
  /**
   * Reap the seat's agent PROCESS while KEEPING the estate pane: respawn the pane
   * bare (kill the running command, restart the shell). The pane id and its
   * canonical-id tag survive, so the seat stays in the estate and returns to the
   * freelist live+empty. Returns false if the pane could not be resolved/respawned
   * (caller must NOT attest process_reaped/seat_cleared on a failed reap). A
   * failed respawn restores an explicitly supplied prior tint, or the exact raw
   * pane-local style pair observed before clearing when the caller omits it.
   */
  reapSeat(seatId: string, previousTint?: string | null): Promise<boolean>;
  /** Clear pane history, replace its process, and re-verify its canonical tag. */
  resetSeat(seatId: string): Promise<boolean>;
  /** Reconstruct every terminal process and the declared geometry inside one page border. */
  rebuildPage(page: string): Promise<boolean>;
  /** Start through the sanctioned wrapper in the already-declared physical seat. */
  startStaticAgent(launch: StaticAgentLaunch): Promise<boolean>;
  /** Prove the wrapper/engine process pair belongs to the expected physical seat. */
  attestStaticAgent(
    seatId: string,
    wrapperPid: number,
    enginePid: number,
    engine: 'claude' | 'codex',
    engineExecutable: string,
  ): Promise<boolean>;
  /** Apply or clear the persona tint and verify both pane-local tmux style options. */
  setSeatTint(seatId: string, tint: string | null): Promise<boolean>;
  /** Observe the verified pane-local tint; undefined means absent/unreadable, null means fail-dark. */
  seatTint(seatId: string): Promise<string | null | undefined>;
  /** Observe txd's opaque physical pane generation (never a raw tmux handle). */
  seatGeneration(seatId: string): Promise<string | undefined>;
  /** Type text into the seat's pane. Reports full/partial/none delivery. Resolves %id below the membrane. */
  sendToSeat(seatId: string, text: string): Promise<SendOutcome>;
  /** Apply one semantic plan-mode intent with engine-specific input and screen read-back. */
  transitionAgentMode(
    seatId: string,
    engine: 'claude' | 'codex',
    intent: ModeTransitionIntent,
  ): Promise<AgentModeTransitionOutcome>;
  /** Replace the one transient, non-executing clipboard buffer. */
  loadClipboard(text: string): Promise<number>;
  /** Read the one transient clipboard buffer as raw bytes. */
  readClipboard(): Promise<Uint8Array>;
  /** Commit one selection to the transient buffer and its invoking attached client. */
  commitClipboardSelection(text: string, clientTty: string): Promise<number>;
}

const CANON_OPT = '@canonical_id';
const GENERATION_OPT = '@txd_generation';
type EstateRow = {
  session: string;
  window: string;
  seat: string;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
};
const PREVIOUS_WINDOWS = {
  reservists: ['reservists:W', 'reservists:N', 'reservists:S', 'reservists:E'],
  palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
  somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
  council: ['council:custodes', 'council:pax', 'council:malcador', 'council:true-terminal', 'council:administratum'],
  mechanicus: ['mechanicus:fabricator-general', 'mechanicus:orchestrator'],
} as const;

export type TmuxCommandResult = { code: number; stdout: string; stderr: string };
type TmuxRunner = (socket: string, args: string[], stdin?: Uint8Array) => Promise<TmuxCommandResult>;
type TmuxBinaryResult = { code: number; stdout: Uint8Array; stderr: string; overflow?: boolean };
type TmuxBinaryRunner = (socket: string, args: string[]) => Promise<TmuxBinaryResult>;
type Sleep = (ms: number) => Promise<void>;
type WriteClient = (path: string, data: Uint8Array) => Promise<void>;

export type TmuxAuditRecord = {
  operation: string;
  target: string;
  outcome: 'succeeded' | 'failed';
  duration_ms: number;
  stderr_category: 'none' | 'not_found' | 'permission_denied' | 'transport_error' | 'command_failed';
};
type AuditSink = (record: TmuxAuditRecord) => void;

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        overflow = true;
        onOverflow();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (overflow) return { bytes: new Uint8Array(), overflow };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow };
}

async function spawnTmux(
  socket: string,
  args: string[],
  stdin?: Uint8Array,
  stdoutLimit = 8 * 1024 * 1024,
): Promise<TmuxBinaryResult> {
  const proc = Bun.spawn(['tmux', '-L', socket, ...args], {
    stdin: stdin === undefined ? undefined : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    readLimited(proc.stdout, stdoutLimit, () => proc.kill()),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.bytes, stderr, overflow: stdout.overflow };
}

async function run(socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> {
  const result = await spawnTmux(socket, args, stdin);
  if (result.overflow) return { code: 1, stdout: '', stderr: 'output exceeded limit' };
  return { ...result, stdout: new TextDecoder().decode(result.stdout) };
}

async function runBytes(socket: string, args: string[]): Promise<TmuxBinaryResult> {
  return spawnTmux(socket, args, undefined, MAX_CLIPBOARD_BYTES);
}

export class RealTmux implements TmuxControlPlane {
  private runner: TmuxRunner;
  private audit: AuditSink;
  private sleep: Sleep;
  private enterDelayMs: number;
  private binaryRunner: TmuxBinaryRunner;
  private writeClient: WriteClient;

  constructor(
    private socket: string,
    options: {
      run?: TmuxRunner;
      runBytes?: TmuxBinaryRunner;
      writeClient?: WriteClient;
      audit?: AuditSink;
      sleep?: Sleep;
      enterDelayMs?: number;
    } = {},
  ) {
    this.runner = options.run ?? run;
    this.binaryRunner = options.runBytes ?? runBytes;
    this.audit = options.audit ?? ((record) => console.info(JSON.stringify({ level: 'info', event: 'tmux_operation', ...record })));
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.writeClient = options.writeClient ?? (async (path, data) => {
      const handle = await open(path, 'w');
      try {
        await handle.write(data);
      } finally {
        await handle.close();
      }
    });
    const configured = Number(process.env.TXD_SEND_ENTER_DELAY_MS);
    this.enterDelayMs = options.enterDelayMs
      ?? (Number.isFinite(configured) && configured >= 0 ? configured : 200);
  }

  private stderrCategory(result: TmuxCommandResult): TmuxAuditRecord['stderr_category'] {
    if (result.code === 0) return 'none';
    const stderr = result.stderr.toLowerCase();
    if (/can't find|not found|no server|no such|missing/.test(stderr)) return 'not_found';
    if (/permission|denied|not permitted/.test(stderr)) return 'permission_denied';
    if (/connect|socket|server exited|lost server/.test(stderr)) return 'transport_error';
    return 'command_failed';
  }

  private operationClass(detail: string): string {
    if (detail.startsWith('tag ')) return 'tag_seat';
    if (detail.startsWith('create ') || detail.startsWith('split ')) return 'construct_estate';
    return 'estate_operation';
  }

  /** The sole command boundary. Arguments and raw tmux identifiers never enter its audit record. */
  private async command(operation: string, target: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> {
    const started = performance.now();
    let result: TmuxCommandResult;
    try {
      result = await this.runner(this.socket, args, stdin);
    } catch {
      result = { code: 1, stdout: '', stderr: 'transport failure' };
    }
    this.audit({
      operation,
      target: /[%@$]\d+/.test(target) ? 'invalid-canonical-target' : target,
      outcome: result.code === 0 ? 'succeeded' : 'failed',
      duration_ms: Math.max(0, performance.now() - started),
      stderr_category: this.stderrCategory(result),
    });
    return result;
  }

  async reachable(): Promise<boolean> {
    // Observation only: starting the server here would make it a child of the
    // sandboxed txd.service and propagate NoNewPrivileges to every estate pane.
    const r = await this.command('probe_server', 'server', ['show-options', '-g', 'exit-empty']);
    return r.code === 0;
  }

  async version(): Promise<string | null> {
    const r = await this.command('observe_version', 'server', ['-V']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async loadClipboard(text: string): Promise<number> {
    const bytes = new TextEncoder().encode(text);
    await this.replaceClipboard(bytes, 'clipboard_pull');
    return bytes.byteLength;
  }

  private async replaceClipboard(bytes: Uint8Array, operation: string): Promise<void> {
    const direction = operation === 'clipboard_pull' ? 'pull' : 'selection';
    if (bytes.byteLength === 0) {
      await this.command(operation, CLIPBOARD_BUFFER_NAME, ['delete-buffer', '-b', CLIPBOARD_BUFFER_NAME]);
    } else {
      const result = await this.command(operation, CLIPBOARD_BUFFER_NAME, ['load-buffer', '-b', CLIPBOARD_BUFFER_NAME, '-'], bytes);
      if (result.code !== 0) throw new Error(`txd clipboard ${direction} failed: ${this.stderrCategory(result)}`);
    }
    const marker = await this.command(operation, CLIPBOARD_BUFFER_NAME, ['set-option', '-g', '@tx_clipboard_empty', bytes.byteLength === 0 ? '1' : '0']);
    if (marker.code !== 0) throw new Error(`txd clipboard ${direction} failed: ${this.stderrCategory(marker)}`);
  }

  async commitClipboardSelection(text: string, clientTty: string): Promise<number> {
    const bytes = new TextEncoder().encode(text);
    validateClipboardBytes(bytes);
    const clients = await this.command(
      'observe_clipboard_clients',
      'invoking-client',
      ['list-clients', '-F', '#{client_tty}'],
    );
    if (clients.code !== 0) throw new Error('attached clients are unavailable');
    const target = validateAttachedClientTty(
      clientTty,
      clients.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
    );
    try {
      await this.replaceClipboard(bytes, 'clipboard_selection');
      await this.writeClient(target, osc52Sequence(bytes));
      await this.command(
        'report_clipboard_selection',
        'invoking-client',
        ['display-message', '-c', target, `clipboard push succeeded (${bytes.byteLength} bytes)`],
      );
      return bytes.byteLength;
    } catch (error) {
      await this.command(
        'report_clipboard_selection',
        'invoking-client',
        ['display-message', '-c', target, `clipboard push failed (${bytes.byteLength} bytes)`],
      );
      throw error;
    }
  }

  async readClipboard(): Promise<Uint8Array> {
    const started = performance.now();
    let result: TmuxBinaryResult;
    try {
      result = await this.binaryRunner(this.socket, ['save-buffer', '-b', 'tx-clipboard', '-']);
    } catch {
      result = { code: 1, stdout: new Uint8Array(), stderr: 'transport failure' };
    }
    const classified = { code: result.code, stdout: '', stderr: result.stderr };
    if (result.overflow) {
      this.audit({
        operation: 'clipboard_push',
        target: 'tx-clipboard',
        outcome: 'failed',
        duration_ms: Math.max(0, performance.now() - started),
        stderr_category: this.stderrCategory(classified),
      });
      throw new Error('clipboard payload exceeds 1 MiB');
    }
    this.audit({
      operation: 'clipboard_push',
      target: 'tx-clipboard',
      outcome: result.code === 0 ? 'succeeded' : 'failed',
      duration_ms: Math.max(0, performance.now() - started),
      stderr_category: this.stderrCategory(classified),
    });
    if (result.code !== 0) {
      const marker = await this.command('clipboard_push', 'tx-clipboard', ['show-options', '-gqv', '@tx_clipboard_empty']);
      if (marker.code === 0 && marker.stdout.trim() === '1') return new Uint8Array();
      throw new Error(`txd clipboard push failed: ${this.stderrCategory(classified)}`);
    }
    return result.stdout;
  }

  async workloads(): Promise<SeatWorkload[]> {
    const r = await this.command('observe_workloads', 'estate', ['list-panes', '-a', '-F', `#{${CANON_OPT}}\t#{pane_current_command}`]);
    if (r.code !== 0) return [];
    const idle = new Set(['bash', 'zsh', 'fish', 'sh', 'dash']);
    return r.stdout.split('\n').filter(Boolean).flatMap((line) => {
      const [seat_id, command = ''] = line.split('\t');
      return seat_id ? [{ seat_id, command, idle: idle.has(command) }] : [];
    });
  }

  async killServer(): Promise<boolean> {
    return (await this.command('rotate_estate', 'estate', ['kill-server'])).code === 0;
  }

  /** Resolve canonical id -> internal %id (membrane; return value stays inside). */
  private async resolvePane(seatId: string): Promise<string | null> {
    const r = await this.command('resolve_seat', seatId, ['list-panes', '-a', '-F', `#{pane_id}\t#{${CANON_OPT}}`]);
    if (r.code !== 0) return null;
    for (const line of r.stdout.split('\n')) {
      const [paneId, canon] = line.split('\t');
      if (canon === seatId && paneId) return paneId;
    }
    return null;
  }

  async listSeats(): Promise<SeatObservation[]> {
    const r = await this.command('observe_seats', 'estate', ['list-panes', '-a', '-F', `#{${CANON_OPT}}\t#{pane_dead}`]);
    if (r.code !== 0) return [];
    const out: SeatObservation[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [canon, dead] = line.split('\t');
      if (!canon) continue; // untagged panes are not seats
      out.push({ seat_id: canon, pane: dead === '1' ? 'dead' : 'live' });
    }
    return out;
  }

  private async checked(args: string[], operation: string, target = 'estate'): Promise<string> {
    const result = await this.command(this.operationClass(operation), target, args);
    if (result.code !== 0) {
      throw new Error(`txd tmux ${operation} failed: ${this.stderrCategory(result)}`);
    }
    return result.stdout.trim();
  }

  private homeDirectory(): string {
    const home = process.env.HOME;
    if (!home) throw new Error('txd tmux requires HOME to create panes');
    return home;
  }

  private async estateChecked(args: string[], operation: string, target = 'estate'): Promise<string> {
    return this.checked([...args, '-c', this.homeDirectory()], operation, target);
  }

  private async estateRows(): Promise<EstateRow[]> {
    const result = await this.command('observe_estate', 'estate', [
      'list-panes', '-a', '-F',
      `#{session_name}\t#{window_name}\t#{${CANON_OPT}}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}`,
    ]);
    if (result.code !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [
        session = '', window = '', seat = '', left = '', top = '', width = '',
        height = '', windowWidth = '', windowHeight = '',
      ] = line.split('\t');
      return {
        session,
        window,
        seat,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        windowWidth: Number(windowWidth),
        windowHeight: Number(windowHeight),
      };
    }).filter((row) => row.seat.length > 0);
  }

  private pageGeometryMatches(window: string, seats: readonly string[], rows: EstateRow[]): boolean {
    const panes = rows.filter((row) => row.session === TXD_SESSION && row.window === window);
    if (panes.length !== seats.length) return false;
    const bySeat = new Map(panes.map((row) => [row.seat, row]));
    if (seats.some((seat) => !bySeat.has(seat))) return false;

    if (window === 'council' && seats.length === 4) {
      const nw = bySeat.get(seats[0]!)!;
      const sw = bySeat.get(seats[1]!)!;
      const ne = bySeat.get(seats[2]!)!;
      const se = bySeat.get(seats[3]!)!;
      const originTop = Math.min(...panes.map((pane) => pane.top));
      return nw.left === 0 && nw.top === originTop
        && sw.left === 0 && sw.top === nw.top + nw.height + 1
        && ne.left === nw.width + 1 && ne.top === originTop
        && se.left === ne.left && se.top === ne.top + ne.height + 1
        && nw.width === sw.width && ne.width === se.width
        && nw.height === ne.height && sw.height === se.height
        && ne.left + ne.width === nw.windowWidth
        && sw.top + sw.height === nw.windowHeight
        && se.top + se.height === nw.windowHeight;
    }
    if (window === 'council' && seats.length === 5) {
      // The preceding constructor repeatedly split the original top pane.
      // Declaration order records creation/tag order; physical top-to-bottom
      // order is first, then newest-to-oldest split.
      const physicalOrder = [seats[0]!, seats[4]!, seats[3]!, seats[2]!, seats[1]!];
      const stack = physicalOrder.map((seat) => bySeat.get(seat)!);
      const originTop = Math.min(...panes.map((pane) => pane.top));
      return stack.every((pane, index) =>
        pane.left === 0
        && pane.width === pane.windowWidth
        && pane.top === (index === 0 ? originTop : stack[index - 1]!.top + stack[index - 1]!.height + 1),
      ) && stack.at(-1)!.top + stack.at(-1)!.height === stack[0]!.windowHeight;
    }
    if (window === 'mechanicus' && seats.length === 2) {
      const west = bySeat.get(seats[0]!)!;
      const east = bySeat.get(seats[1]!)!;
      const originTop = Math.min(...panes.map((pane) => pane.top));
      return west.left === 0 && west.top === originTop && east.top === originTop
        && west.top + west.height === west.windowHeight
        && east.top + east.height === west.windowHeight
        && east.left === west.width + 1
        && east.left + east.width === west.windowWidth;
    }
    return true;
  }

  private exactShape(rows: EstateRow[], windows: Record<string, readonly string[]>): boolean {
    const expected = Object.entries(windows)
      .flatMap(([window, seats]) => seats.map((seat) => `${TXD_SESSION}\t${window}\t${seat}`))
      .sort();
    const actual = rows.map((row) => `${row.session}\t${row.window}\t${row.seat}`).sort();
    return actual.length === expected.length
      && actual.every((row, index) => row === expected[index])
      && Object.entries(windows).every(([window, seats]) => this.pageGeometryMatches(window, seats, rows));
  }

  private isCanonicalEstate(rows: EstateRow[]): boolean {
    return this.canonicalDivergence(rows) === null;
  }

  /** Human-readable live geometry for one page — the observed value an operator needs. */
  private describePage(page: string, rows: EstateRow[]): string {
    const panes = rows.filter((row) => row.session === TXD_SESSION && row.window === page);
    if (panes.length === 0) return 'no tagged panes';
    const window = `window ${panes[0]!.windowWidth}x${panes[0]!.windowHeight}`;
    const seats = panes
      .map((pane) => `${pane.seat || '<untagged>'}@${pane.left},${pane.top}+${pane.width}x${pane.height}`)
      .sort()
      .join(' ');
    return `${window}; ${seats}`;
  }

  /**
   * The single canonical acceptance predicate, stated as its own divergence.
   * Returns null when `rows` are canonical, otherwise the exact mismatch —
   * a postcondition an operator cannot act on is a postcondition that turns a
   * repairable estate into an anonymous outage.
   */
  private canonicalDivergence(rows: EstateRow[]): string | null {
    const expected = Object.entries(TXD_WINDOWS)
      .flatMap(([window, seats]) => seats.map((seat) => `${TXD_SESSION}\t${window}\t${seat}`))
      .sort();
    const actual = rows.map((row) => `${row.session}\t${row.window}\t${row.seat}`).sort();
    if (actual.length !== expected.length || !actual.every((row, index) => row === expected[index])) {
      const render = (list: string[]): string =>
        list.length === 0 ? 'none' : list.map((row) => row.split('\t').join(':')).join(', ');
      return 'estate seats diverged'
        + ` (missing: ${render(expected.filter((row) => !actual.includes(row)))};`
        + ` unexpected: ${render(actual.filter((row) => !expected.includes(row)))};`
        + ` observed ${actual.length} of ${expected.length} canonical panes)`;
    }
    for (const [window, seats] of Object.entries(TXD_WINDOWS)) {
      if (!this.pageGeometryMatches(window, seats, rows)) {
        return `page ${window} geometry is not canonical: ${this.describePage(window, rows)}`;
      }
    }
    return null;
  }

  async estateGeneration(): Promise<EstateGeneration> {
    const rows = await this.estateRows();
    if (rows.length === 0) return 'empty';
    if (this.isCanonicalEstate(rows)) return 'canonical';
    if (this.exactShape(rows, PREVIOUS_WINDOWS)) return 'council-mechanicus';
    if (this.exactShape(rows, { ...TXD_WINDOWS, mechanicus: PREVIOUS_WINDOWS.mechanicus })) return 'migration-interrupted';
    const recoverable = rows.every((row) => {
      const seats = TXD_WINDOWS[row.window as keyof typeof TXD_WINDOWS] as readonly string[] | undefined;
      return row.session === TXD_SESSION && seats !== undefined && (row.seat === '' || seats.includes(row.seat));
    });
    return recoverable ? 'recoverable' : 'foreign';
  }

  async migrateCouncil(pending: boolean): Promise<boolean> {
    const generation = await this.estateGeneration();
    if (generation === 'canonical') return pending;
    if (generation !== 'council-mechanicus' && !(pending && generation === 'migration-interrupted')) return false;
    if (generation === 'council-mechanicus' && !(await this.rebuildPage('council'))) return false;
    const mechanicus = await this.command('retire_page', 'mechanicus', ['kill-window', '-t', `${TXD_SESSION}:mechanicus`]);
    if (mechanicus.code !== 0 && this.stderrCategory(mechanicus) !== 'not_found') return false;
    return this.isCanonicalEstate(await this.estateRows());
  }

  private async tag(paneId: string, seatId: string): Promise<void> {
    await this.checked(['set-option', '-p', '-t', paneId, CANON_OPT, seatId], `tag ${seatId}`, seatId);
    await this.checked(['set-option', '-p', '-t', paneId, GENERATION_OPT, crypto.randomUUID()], `tag ${seatId} generation`, seatId);
  }

  private async ensureSeatGeneration(seatId: string): Promise<void> {
    if (await this.seatGeneration(seatId)) return;
    const paneId = await this.resolvePane(seatId);
    if (!paneId) throw new Error(`txd cannot resolve seat generation for ${seatId}`);
    await this.checked(
      ['set-option', '-p', '-t', paneId, GENERATION_OPT, crypto.randomUUID()],
      `tag ${seatId} generation`,
      seatId,
    );
    if (!(await this.seatGeneration(seatId))) throw new Error(`txd cannot attest seat generation for ${seatId}`);
  }

  private async clearPaneUserOptions(paneId: string, page: string): Promise<void> {
    const options = await this.command('observe_page_options', page, ['show-options', '-p', '-t', paneId]);
    if (options.code !== 0) throw new Error(`txd tmux page option observation failed: ${this.stderrCategory(options)}`);
    for (const line of options.stdout.split('\n')) {
      const name = line.trim().split(/\s+/, 1)[0];
      if (name?.startsWith('@')) await this.checked(['set-option', '-p', '-u', '-t', paneId, name], `clear ${page} option`, page);
    }
  }

  private async clearWindowUserOptions(target: string, page: string): Promise<void> {
    const options = await this.command('observe_page_window_options', page, ['show-options', '-w', '-t', target]);
    if (options.code !== 0) throw new Error(`txd tmux page window option observation failed: ${this.stderrCategory(options)}`);
    for (const line of options.stdout.split('\n')) {
      const name = line.trim().split(/\s+/, 1)[0];
      if (name?.startsWith('@')) await this.checked(['set-option', '-w', '-u', '-t', target, name], `clear ${page} window option`, page);
    }
  }

  private async constructPage(page: string, seed?: string): Promise<string[]> {
    const first = seed ?? await this.estateChecked(
      ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', page],
      `create ${page} window`,
      page,
    );
    let panes: string[];
    if (page === 'reservists' || page === 'palace') {
      const center = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '70%', '-t', first], `split ${page} center`, page);
      const east = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '43%', '-t', center], `split ${page} east`, page);
      const south = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', center], `split ${page} south`, page);
      panes = [first, center, south, east];
    } else if (page === 'somnium') {
      const north = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '70%', '-t', first], 'split somnium grid', page);
      const northeast = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', north], 'split somnium east column', page);
      const south = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', north], 'split somnium south', page);
      const southeast = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', northeast], 'split somnium southeast', page);
      panes = [first, north, south, northeast, southeast];
    } else if (page === 'council') {
      const northeast = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', first],
        'split council east column',
        page,
      );
      const southwest = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', first],
        'split council southwest',
        page,
      );
      const southeast = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', northeast],
        'split council southeast',
        page,
      );
      panes = [first, southwest, northeast, southeast];
    } else {
      throw new Error(`txd refused unknown page ${page}`);
    }
    const seats = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS];
    await Promise.all(seats.map((seat, index) => this.tag(panes[index]!, seat)));
    return panes;
  }

  /**
   * Clear display-only zoom on a page. Zoom is the one canonical-shape
   * violation that costs nothing to correct: every pane is the right process in
   * the right place, so un-zooming restores canonical geometry without
   * replacing a single terminal.
   */
  private async clearPageZoom(page: string, target: string): Promise<boolean> {
    const zoomed = await this.command('observe_page_zoom', page, ['display-message', '-p', '-t', target, '#{window_zoomed_flag}']);
    if (zoomed.code !== 0) return false;
    if (zoomed.stdout.trim() !== '1') return true;
    return (await this.command('clear_page_zoom', page, ['resize-pane', '-Z', '-t', target])).code === 0;
  }

  /** The canonical acceptance predicate for one page: live seats and geometry. */
  private async pageIsCanonical(page: string, expected: readonly string[]): Promise<boolean> {
    const live = (await this.listSeats())
      .filter((seat) => seat.pane === 'live' && seat.seat_id.split(':', 1)[0] === page)
      .map((seat) => seat.seat_id)
      .sort();
    const want = [...expected].sort();
    if (live.length !== want.length || !live.every((seat, index) => seat === want[index])) return false;
    return this.pageGeometryMatches(page, expected, await this.estateRows());
  }

  /**
   * Drive one canonical page to canonical shape. Recovery enforces rather than
   * observes: it acts, then re-reads the estate to attest what the action did.
   * Enforcement escalates so repair stays proportionate to the damage —
   * display-only drift is corrected in place, and only damage that survives
   * that earns the destructive rebuild which replaces every process on the page.
   */
  private async enforcePage(page: string, expected: readonly string[]): Promise<{ canonical: boolean; rebuilt: boolean }> {
    if (await this.pageIsCanonical(page, expected)) return { canonical: true, rebuilt: false };
    if (await this.clearPageZoom(page, `${TXD_SESSION}:${page}`) && await this.pageIsCanonical(page, expected)) {
      return { canonical: true, rebuilt: false };
    }
    if (!(await this.rebuildPage(page))) return { canonical: false, rebuilt: true };
    return { canonical: await this.pageIsCanonical(page, expected), rebuilt: true };
  }

  async rebuildPage(page: string): Promise<boolean> {
    if (!Object.hasOwn(TXD_WINDOWS, page)) return false;
    const target = `${TXD_SESSION}:${page}`;
    try {
      const listed = await this.command('observe_page_panes', page, ['list-panes', '-t', target, '-F', '#{pane_id}']);
      let seed: string | undefined;
      if (listed.code === 0) {
        seed = listed.stdout.trim().split('\n').filter(Boolean)[0];
        if (seed) {
          if (!(await this.clearPageZoom(page, seed))) return false;
          if ((await this.command('clear_page_to_seed', page, ['kill-pane', '-a', '-t', seed])).code !== 0) return false;
          if ((await this.command('clear_page_history', page, ['clear-history', '-t', seed])).code !== 0) return false;
          await this.clearPaneUserOptions(seed, page);
          await this.clearWindowUserOptions(target, page);
          const defaultShell = await this.command(
            'observe_default_shell',
            page,
            ['show-options', '-gv', 'default-shell'],
          );
          const shellCommand = defaultShell.stdout.trim();
          if (defaultShell.code !== 0 || shellCommand === '') return false;
          if ((await this.command('reset_page_seed', page, [
            'respawn-pane', '-k', '-c', this.homeDirectory(), '-t', seed, shellCommand,
          ])).code !== 0) return false;
        }
      } else if (this.stderrCategory(listed) !== 'not_found') {
        return false;
      }
      await this.constructPage(page, seed);
      const rows = await this.estateRows();
      const expected = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS];
      for (const seat of expected) {
        if (!(await this.setSeatTint(seat, null))) return false;
      }
      const observed = await this.listSeats();
      const live = new Set(observed.filter((seat) => seat.pane === 'live').map((seat) => seat.seat_id));
      return expected.every((seat) => live.has(seat))
        && this.pageGeometryMatches(page, expected, rows);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'page_rebuild_failed', page, error: String(error) }));
      return false;
    }
  }

  async ensureEstate(): Promise<EstateEnsureResult> {
    if (!(await this.reachable())) {
      throw new Error('txd tmux server is not externally owned; tx-estate.service must start it before txd');
    }
    const rows = await this.estateRows();
    if (rows.length > 0) {
      const recoverable = rows.every((row) => {
        const seats = TXD_WINDOWS[row.window as keyof typeof TXD_WINDOWS] as readonly string[] | undefined;
        return row.session === TXD_SESSION && seats !== undefined && (row.seat === '' || seats.includes(row.seat));
      });
      if (!recoverable) throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
      // Canonical recovery is enforcement, not assertion. Every page is driven
      // to canonical shape against the same predicate that later accepts it;
      // a repair trigger weaker than the acceptance predicate leaves drift that
      // is observed, called recoverable, never repaired, and then fatal.
      const rebuilt_pages: TxdPage[] = [];
      for (const [page, expectedSeats] of Object.entries(TXD_WINDOWS)) {
        const enforced = await this.enforcePage(page, expectedSeats);
        if (enforced.rebuilt) rebuilt_pages.push(page as TxdPage);
        if (!enforced.canonical) {
          throw new Error(
            `txd could not drive canonical page ${page} to canonical shape: ${this.describePage(page, await this.estateRows())}`,
          );
        }
      }
      const divergence = this.canonicalDivergence(await this.estateRows());
      if (divergence) throw new Error(`txd canonical estate recovery could not converge: ${divergence}`);
      for (const seat of TXD_ESTATE) await this.ensureSeatGeneration(seat);
      return { state: 'existing', rebuilt_pages };
    }

    let sessionCreated = false;
    try {
      const reservistsW = await this.estateChecked(
        ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', TXD_SESSION, '-n', 'reservists', '-x', '200', '-y', '60'],
        'create canonical session',
      );
      sessionCreated = true;
      const reservistsN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '70%', '-t', reservistsW], 'split reservists center');
      const reservistsE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '43%', '-t', reservistsN], 'split reservists east');
      const reservistsS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', reservistsN], 'split reservists south');
      await Promise.all([
        this.tag(reservistsW, 'reservists:W'), this.tag(reservistsN, 'reservists:N'),
        this.tag(reservistsS, 'reservists:S'), this.tag(reservistsE, 'reservists:E'),
      ]);

      const palaceW = await this.estateChecked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'palace'],
        'create palace window',
      );
      const palaceN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '70%', '-t', palaceW], 'split palace center');
      const palaceE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '43%', '-t', palaceN], 'split palace east');
      const palaceS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', palaceN], 'split palace south');
      await Promise.all([
        this.tag(palaceW, 'palace:W'), this.tag(palaceN, 'palace:N'),
        this.tag(palaceS, 'palace:S'), this.tag(palaceE, 'palace:E'),
      ]);

      const somniumW = await this.estateChecked(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'somnium'], 'create somnium window');
      const somniumN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '70%', '-t', somniumW], 'split somnium grid');
      const somniumNE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', somniumN], 'split somnium east column');
      const somniumS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', somniumN], 'split somnium south');
      const somniumSE = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', somniumNE], 'split somnium southeast');
      await Promise.all([
        this.tag(somniumW, 'somnium:W'), this.tag(somniumN, 'somnium:N'),
        this.tag(somniumS, 'somnium:S'), this.tag(somniumNE, 'somnium:NE'), this.tag(somniumSE, 'somnium:SE'),
      ]);

      const council = await this.estateChecked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'council'],
        'create council window',
      );
      const councilNE = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', council],
        'split council east column',
      );
      const councilSW = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', council],
        'split council southwest',
      );
      const councilSE = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-l', '50%', '-t', councilNE],
        'split council southeast',
      );
      const councilPanes = [council, councilSW, councilNE, councilSE];
      await Promise.all(TXD_WINDOWS.council.map((seat, index) => this.tag(councilPanes[index]!, seat)));

      // Construction owns an empty socket and every pane it just made. A shape
      // that is still wrong here is not estate drift to be enforced away — it
      // is a broken constructor, so roll the whole session back and say why.
      const divergence = this.canonicalDivergence(await this.estateRows());
      if (divergence) throw new Error(`txd canonical estate construction postcondition failed: ${divergence}`);
      return { state: 'created', rebuilt_pages: Object.keys(TXD_WINDOWS) as TxdPage[] };
    } catch (error) {
      if (sessionCreated) await this.command('rollback_estate', 'estate', ['kill-session', '-t', TXD_SESSION]);
      throw error;
    }
  }

  async createSeat(seatId: string): Promise<void> {
    if (!(await this.reachable())) {
      throw new Error('txd tmux server is not externally owned; refusing to spawn it inside txd');
    }
    // Sanitized tmux session name (canonical id may contain `:`); the true id
    // lives in the pane option only.
    const safe = `seat_${seatId.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const created = await this.command('create_seat', seatId, ['new-session', '-d', '-s', safe, '-x', '200', '-y', '50', '-c', this.homeDirectory()]);
    // Fail loud: if the session didn't come up, do NOT go on to list/retag some
    // other pane and record a seat that was never really created.
    if (created.code !== 0) {
      throw new Error(`txd tmux createSeat failed for ${seatId}: ${this.stderrCategory(created)}`);
    }
    try {
      const paneR = await this.command('resolve_created_seat', seatId, ['list-panes', '-t', safe, '-F', '#{pane_id}']);
      const paneId = paneR.stdout.trim().split('\n')[0];
      if (paneR.code !== 0 || !paneId) {
        throw new Error(`txd tmux createSeat: no pane for ${seatId}`);
      }
      const tag = await this.command('tag_seat', seatId, ['set-option', '-p', '-t', paneId, CANON_OPT, seatId]);
      if (tag.code !== 0) throw new Error(`txd tmux tag_seat failed for ${seatId}: ${this.stderrCategory(tag)}`);
      const generation = await this.command('tag_seat_generation', seatId, [
        'set-option', '-p', '-t', paneId, GENERATION_OPT, crypto.randomUUID(),
      ]);
      if (generation.code !== 0) throw new Error(`txd tmux tag_seat_generation failed for ${seatId}: ${this.stderrCategory(generation)}`);
      const tagged = await this.command('verify_seat_tag', seatId, ['list-panes', '-t', safe, '-F', `#{pane_id}\t#{${CANON_OPT}}`]);
      const rows = tagged.stdout.trim().split('\n').filter(Boolean);
      if (tagged.code !== 0 || rows.length !== 1 || rows[0] !== `${paneId}\t${seatId}`) {
        throw new Error(`txd tmux canonical tag verification failed for ${seatId}`);
      }
    } catch (error) {
      // Compensation is deliberately scoped to the session created above. No
      // canonical lookup can find an untagged pane, and no existing estate seat
      // is eligible for removal here.
      await this.command('rollback_seat', seatId, ['kill-session', '-t', safe]);
      throw error;
    }
  }

  async killSeat(seatId: string): Promise<void> {
    const paneId = await this.resolvePane(seatId);
    if (paneId) await this.command('kill_seat', seatId, ['kill-pane', '-t', paneId]);
  }

  async reapSeat(seatId: string, previousTint?: string | null): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    const stylesToRestore = previousTint === undefined
      ? await this.observePaneStyles(seatId, paneId)
      : undefined;
    if (previousTint === undefined && stylesToRestore === undefined) return false;
    // Clear and attest the identity signal before killing the bound process.
    // If respawn then fails, restore the still-current binding's physical style.
    if (!(await this.setSeatTint(seatId, null))) return false;
    // -k kills the pane's current command; the pane (and its @canonical_id option)
    // is REUSED and a fresh default shell is started — the estate seat persists.
    const r = await this.command('reap_seat', seatId, ['respawn-pane', '-k', '-t', paneId]);
    if (r.code === 0) return true;
    const restored = stylesToRestore === undefined
      ? previousTint === null || await this.setSeatTint(seatId, previousTint!)
      : await this.restorePaneStyles(seatId, paneId, stylesToRestore);
    if (!restored) {
      throw new Error(`txd failed to restore binding tint after reap failure for ${seatId}`);
    }
    return false;
  }

  async resetSeat(seatId: string): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    if ((await this.command('clear_seat_history', seatId, ['clear-history', '-t', paneId])).code !== 0) return false;
    if ((await this.command('reset_seat_process', seatId, ['respawn-pane', '-k', '-t', paneId])).code !== 0) return false;
    const verified = await this.command('verify_reset_seat_tag', seatId, ['display-message', '-p', '-t', paneId, `#{${CANON_OPT}}`]);
    return verified.code === 0 && verified.stdout.trim() === seatId && await this.setSeatTint(seatId, null);
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
  }

  async startStaticAgent(launch: StaticAgentLaunch): Promise<boolean> {
    const paneId = await this.resolvePane(launch.seatId);
    if (!paneId) return false;
    const environment = Object.entries(launch.environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const command = `exec ${this.shellQuote(launch.wrapper)} ${launch.engine}`;
    const result = await this.command('start_static_agent', launch.seatId, [
      'respawn-pane', '-k', '-c', launch.workspace, ...environment, '-t', paneId, command,
    ]);
    return result.code === 0;
  }

  async attestStaticAgent(
    seatId: string,
    wrapperPid: number,
    enginePid: number,
    engine: 'claude' | 'codex',
    engineExecutable: string,
  ): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    const pane = await this.command('attest_static_agent', seatId, [
      'display-message', '-p', '-t', paneId, '#{pane_pid}\t#{pane_dead}',
    ]);
    if (pane.code !== 0) return false;
    const [observedPid, dead] = pane.stdout.trim().split('\t');
    if (Number(observedPid) !== wrapperPid || dead !== '0') return false;
    try {
      const [rawStat, rawComm, observedExecutable] = await Promise.all([
        readFile(`/proc/${enginePid}/stat`, 'utf8'),
        readFile(`/proc/${enginePid}/comm`, 'utf8'),
        readlink(`/proc/${enginePid}/exe`),
      ]);
      const afterName = rawStat.slice(rawStat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const parentPid = Number(afterName[1]);
      const processName = rawComm.trim();
      return parentPid === wrapperPid
        && processName === engine
        && observedExecutable === engineExecutable;
    } catch {
      return false;
    }
  }

  private async observePaneStyles(
    seatId: string,
    paneId: string,
  ): Promise<readonly [string, string] | undefined> {
    const [inactive, active] = await Promise.all([
      this.command('observe_seat_tint', seatId, ['show-options', '-p', '-v', '-t', paneId, 'window-style']),
      this.command('observe_seat_active_tint', seatId, ['show-options', '-p', '-v', '-t', paneId, 'window-active-style']),
    ]);
    if (inactive.code !== 0 || active.code !== 0) return undefined;
    return [
      inactive.stdout.replace(/\r?\n$/, ''),
      active.stdout.replace(/\r?\n$/, ''),
    ];
  }

  private async restorePaneStyles(
    seatId: string,
    paneId: string,
    styles: readonly [string, string],
  ): Promise<boolean> {
    const [inactive, active] = await Promise.all([
      this.command('restore_seat_tint', seatId, [
        'set-option', '-p', '-t', paneId, 'window-style', styles[0],
      ]),
      this.command('restore_seat_active_tint', seatId, [
        'set-option', '-p', '-t', paneId, 'window-active-style', styles[1],
      ]),
    ]);
    if (inactive.code !== 0 || active.code !== 0) return false;
    const observed = await this.observePaneStyles(seatId, paneId);
    return observed?.[0] === styles[0] && observed[1] === styles[1];
  }

  async seatTint(seatId: string): Promise<string | null | undefined> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return undefined;
    const styles = await this.observePaneStyles(seatId, paneId);
    if (!styles) return undefined;
    if (styles.every((style) => style === '' || style === 'default')) return null;
    if (styles[0] === styles[1] && styles[0]?.startsWith('bg=')) return styles[0].slice(3);
    return styles.join('|');
  }

  async seatGeneration(seatId: string): Promise<string | undefined> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return undefined;
    const observed = await this.command('observe_seat_generation', seatId, [
      'display-message', '-p', '-t', paneId, `#{${GENERATION_OPT}}`,
    ]);
    const generation = observed.stdout.trim();
    return observed.code === 0 && generation.length > 0 ? generation : undefined;
  }

  async setSeatTint(seatId: string, tint: string | null): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    const style = tint === null ? 'default' : `bg=${tint}`;
    const applied = await this.command('set_seat_tint', seatId, ['select-pane', '-t', paneId, '-P', style]);
    return applied.code === 0 && await this.seatTint(seatId) === tint;
  }

  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'failed_none_delivered' };
    const literal = await this.command('send_literal', seatId, ['send-keys', '-t', paneId, '-l', text]);
    if (literal.code !== 0) return { bytes: 0, verdict: 'failed_none_delivered' };
    const bytes = Buffer.byteLength(text, 'utf8');

    // The cursor's logical line is the cross-composer editable surface: shell,
    // Codex and Claude all leave swallowed input there. Once submitted, the
    // cursor moves to output or a fresh composer and this line no longer holds
    // the final non-empty line of the sent text.
    const verificationNeedle = text.split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
    const verify = async (): Promise<boolean> => {
      const cursor = await this.command('observe_cursor', seatId, ['display-message', '-p', '-t', paneId, '#{cursor_y}']);
      if (cursor.code !== 0 || !/^\d+$/.test(cursor.stdout.trim())) return false;
      const row = cursor.stdout.trim();
      const captured = await this.command('verify_submit', seatId, ['capture-pane', '-p', '-J', '-t', paneId, '-S', row, '-E', row]);
      return captured.code === 0 && verificationNeedle.length > 0 && !captured.stdout.includes(verificationNeedle);
    };

    // One initial submit plus two bounded retries. Every Enter is separated
    // from the literal paste (and from prior retries) by a tunable backoff.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.sleep(this.enterDelayMs * attempt);
      const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
      if (enter.code === 0 && await verify()) return { bytes, verdict: 'delivered' };
    }
    return { bytes, verdict: 'partial_delivered' };
  }

  static detectAgentMode(capture: string, engine: 'claude' | 'codex'): AgentModeState {
    if (engine === 'claude') {
      if (/(?:^|\s)plan mode on(?:\s|·|$)/.test(capture)) return 'plan';
      if (/(?:accept edits|bypass permissions) on(?:\s|·|$)/.test(capture)) return 'work';
      return 'unknown';
    }
    if (/(?:^|\s)Plan mode(?:\s|\(|·|$)/.test(capture)) return 'plan';
    if (/(?:^|\s)Main \[default\](?:\s|$)/.test(capture)) return 'work';
    return 'unknown';
  }

  private async captureAgentMode(
    seatId: string,
    paneId: string,
    engine: 'claude' | 'codex',
  ): Promise<AgentModeState> {
    const captured = await this.command('observe_agent_mode', seatId, [
      'capture-pane', '-p', '-J', '-t', paneId, '-S', '-12',
    ]);
    if (captured.code !== 0) return 'unknown';
    return RealTmux.detectAgentMode(captured.stdout, engine);
  }

  async transitionAgentMode(
    seatId: string,
    engine: 'claude' | 'codex',
    intent: ModeTransitionIntent,
  ): Promise<AgentModeTransitionOutcome> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) {
      return {
        before: 'unknown',
        after: 'unknown',
        changed: false,
        verified: false,
        mechanism: 'none',
      };
    }
    const before = await this.captureAgentMode(seatId, paneId, engine);
    if (intent === 'enter_plan' && before === 'plan') {
      return { before, after: before, changed: false, verified: true, mechanism: 'none' };
    }

    if (intent === 'toggle_plan' && before === 'plan') {
      const input = await this.command('toggle_agent_mode', seatId, ['send-keys', '-t', paneId, 'BTab']);
      const after = input.code === 0 ? await this.captureAgentMode(seatId, paneId, engine) : 'unknown';
      return {
        before,
        after,
        changed: after === 'work',
        verified: after === 'work',
        mechanism: 'mode_cycle',
      };
    }

    if (engine === 'codex') {
      const typed = await this.command('enter_plan_mode', seatId, ['send-keys', '-t', paneId, '-l', '/plan']);
      const submitted = typed.code === 0
        ? await this.command('enter_plan_mode', seatId, ['send-keys', '-t', paneId, 'Enter'])
        : typed;
      const after = submitted.code === 0 ? await this.captureAgentMode(seatId, paneId, engine) : 'unknown';
      return {
        before,
        after,
        changed: after === 'plan',
        verified: after === 'plan',
        mechanism: 'slash_command',
      };
    }

    // Claude exposes plan as one member of its finite permission-mode cycle.
    // Three inputs cover that closed cycle; each read-back is positive evidence
    // and the loop terminates on the first attested plan footer.
    for (let step = 0; step < 3; step += 1) {
      const input = await this.command('enter_plan_mode', seatId, ['send-keys', '-t', paneId, 'BTab']);
      if (input.code !== 0) break;
      const after = await this.captureAgentMode(seatId, paneId, engine);
      if (after === 'plan') {
        return {
          before,
          after,
          changed: true,
          verified: true,
          mechanism: 'mode_cycle',
        };
      }
    }
    return {
      before,
      after: await this.captureAgentMode(seatId, paneId, engine),
      changed: false,
      verified: false,
      mechanism: 'mode_cycle',
    };
  }
}

// In-memory fake for tests — same membrane contract, no tmux dependency.
export class FakeTmux implements TmuxControlPlane {
  private seats = new Map<string, { pane: 'live' | 'dead'; generation: string }>();
  private failCreate = new Set<string>(); // seats whose createSeat is forced to throw
  private failReap = new Set<string>(); // seats whose reapSeat is forced to fail
  private resets: string[] = [];
  private pageRebuilds: string[] = [];
  reachableFlag = true;
  killed = false;
  private commands = new Map<string, string>();
  private staticAgents = new Map<string, { wrapperPid: number; enginePid: number; engine: 'claude' | 'codex'; launch: StaticAgentLaunch }>();
  private staticStartFailures = new Set<string>();
  private tints = new Map<string, string>();
  private tintFailures = new Set<string>();
  private tintClearFailures = new Set<string>();
  private tintMisapplications = new Set<string>();
  private shape: { sessions: string[]; windows: Record<string, string[]> } = { sessions: [], windows: {} };
  private clipboard = new Uint8Array();
  private agentModes = new Map<string, AgentModeState>();
  private agentModeInputs = new Map<string, string[]>();
  private agentModeFailures = new Set<string>();
  private attachedClients = new Set<string>();
  private deliveredSelections: string[] = [];

  async reachable(): Promise<boolean> {
    return this.reachableFlag;
  }
  async version(): Promise<string | null> {
    return 'tmux 3.5a (fake)';
  }
  async workloads(): Promise<SeatWorkload[]> {
    return [...this.seats.keys()].map((seat_id) => {
      const command = this.commands.get(seat_id) ?? 'bash';
      return { seat_id, command, idle: ['bash', 'zsh', 'fish', 'sh', 'dash'].includes(command) };
    });
  }
  async killServer(): Promise<boolean> { this.killed = true; this.reachableFlag = false; return true; }
  async loadClipboard(text: string): Promise<number> {
    this.clipboard = new TextEncoder().encode(text);
    return this.clipboard.byteLength;
  }
  async readClipboard(): Promise<Uint8Array> { return this.clipboard.slice(); }
  setAgentMode(seatId: string, mode: AgentModeState): void { this.agentModes.set(seatId, mode); }
  modeInputs(seatId: string): string[] { return [...(this.agentModeInputs.get(seatId) ?? [])]; }
  failModeTransition(seatId: string): void { this.agentModeFailures.add(seatId); }
  async transitionAgentMode(
    seatId: string,
    engine: 'claude' | 'codex',
    intent: ModeTransitionIntent,
  ): Promise<AgentModeTransitionOutcome> {
    const before = this.agentModes.get(seatId) ?? 'unknown';
    if (intent === 'enter_plan' && before === 'plan') {
      return { before, after: 'plan', changed: false, verified: true, mechanism: 'none' };
    }
    const entering = before !== 'plan';
    const mechanism = entering && engine === 'codex' ? 'slash_command' : 'mode_cycle';
    const input = entering && engine === 'codex' ? '/plan' : 'BTab';
    this.agentModeInputs.set(seatId, [...(this.agentModeInputs.get(seatId) ?? []), input]);
    if (this.agentModeFailures.has(seatId)) {
      return { before, after: before, changed: false, verified: false, mechanism };
    }
    const after = entering ? 'plan' : 'work';
    this.agentModes.set(seatId, after);
    return { before, after, changed: true, verified: true, mechanism };
  }
  attachClient(tty: string): void { this.attachedClients.add(tty); }
  selectionDeliveries(): string[] { return [...this.deliveredSelections]; }
  async commitClipboardSelection(text: string, clientTty: string): Promise<number> {
    validateAttachedClientTty(clientTty, [...this.attachedClients]);
    const bytes = await this.loadClipboard(text);
    this.deliveredSelections.push(clientTty);
    return bytes;
  }
  setCommand(seatId: string, command: string): void { this.commands.set(seatId, command); }
  async listSeats(): Promise<SeatObservation[]> {
    return [...this.seats].map(([seat_id, s]) => ({ seat_id, pane: s.pane }));
  }
  async ensureEstate(): Promise<EstateEnsureResult> {
    if (this.shape.sessions.length > 0) {
      const canonical = this.shape.sessions.length === 1 && this.shape.sessions[0] === TXD_SESSION
        && JSON.stringify(this.shape.windows) === JSON.stringify(TXD_WINDOWS);
      const allLive = TXD_ESTATE.every((seat) => this.seats.get(seat)?.pane === 'live');
      if (canonical && allLive) return { state: 'existing', rebuilt_pages: [] };
      const recoverable = this.shape.sessions.length === 1 && this.shape.sessions[0] === TXD_SESSION
        && Object.entries(this.shape.windows).every(([page, seats]) => {
          const expected = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS] as readonly string[] | undefined;
          return expected !== undefined && seats.every((seat) => expected.includes(seat));
        });
      if (!recoverable) throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
      const rebuilt_pages: TxdPage[] = [];
      for (const [page, expectedSeats] of Object.entries(TXD_WINDOWS)) {
        const shaped = this.shape.windows[page] ?? [];
        const healthy = shaped.length === expectedSeats.length
          && expectedSeats.every((seat) => shaped.includes(seat) && this.seats.get(seat)?.pane === 'live');
        if (!healthy && !(await this.rebuildPage(page))) throw new Error(`FakeTmux: failed page reconstruction ${page}`);
        if (!healthy) rebuilt_pages.push(page as TxdPage);
      }
      return { state: 'existing', rebuilt_pages };
    }
    this.shape = {
      sessions: [TXD_SESSION],
      windows: Object.fromEntries(Object.entries(TXD_WINDOWS).map(([window, seats]) => [window, [...seats]])),
    };
    for (const seat of TXD_ESTATE) this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
    return { state: 'created', rebuilt_pages: Object.keys(TXD_WINDOWS) as TxdPage[] };
  }
  async estateGeneration(): Promise<EstateGeneration> {
    if (this.shape.sessions.length === 0) return 'empty';
    if (JSON.stringify(this.shape.windows) === JSON.stringify(TXD_WINDOWS)) return 'canonical';
    if (JSON.stringify(this.shape.windows) === JSON.stringify(PREVIOUS_WINDOWS)) return 'council-mechanicus';
    if (JSON.stringify(this.shape.windows) === JSON.stringify({ ...TXD_WINDOWS, mechanicus: [...PREVIOUS_WINDOWS.mechanicus] })) return 'migration-interrupted';
    const recoverable = Object.entries(this.shape.windows).every(([page, seats]) => {
      const expected = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS] as readonly string[] | undefined;
      return expected !== undefined && seats.every((seat) => expected.includes(seat));
    });
    return recoverable ? 'recoverable' : 'foreign';
  }
  async migrateCouncil(pending: boolean): Promise<boolean> {
    const generation = await this.estateGeneration();
    if (generation === 'canonical') return pending;
    if (generation !== 'council-mechanicus' && !(pending && generation === 'migration-interrupted')) return false;
    if (generation === 'council-mechanicus' && !(await this.rebuildPage('council'))) return false;
    delete this.shape.windows.mechanicus;
    for (const seat of PREVIOUS_WINDOWS.mechanicus) this.seats.delete(seat);
    return (await this.estateGeneration()) === 'canonical';
  }
  estateShape(): { sessions: string[]; windows: Record<string, string[]> } {
    return structuredClone(this.shape);
  }
  seedNonCanonicalEstate(): void {
    this.shape = { sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } };
    this.seats.set('palace:W', { pane: 'live', generation: crypto.randomUUID() });
  }
  seedLegacyEstate(): void {
    this.shape = {
      sessions: [TXD_SESSION],
      windows: {
        palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
        somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
        'council:custodes': ['council:custodes'],
        'council:pax': ['council:pax'],
        'council:malcador': ['council:malcador'],
        'council:true-terminal': ['council:true-terminal'],
        'council:administratum': ['council:administratum'],
        'mechanicus:fabricator-general': ['mechanicus:fabricator-general'],
        'mechanicus:orchestrator': ['mechanicus:orchestrator'],
      },
    };
    for (const seats of Object.values(this.shape.windows)) {
      for (const seat of seats) this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
    }
  }
  seedCouncilMechanicusEstate(): void {
    this.shape = {
      sessions: [TXD_SESSION],
      windows: Object.fromEntries(Object.entries(PREVIOUS_WINDOWS).map(([page, seats]) => [page, [...seats]])),
    };
    for (const seats of Object.values(this.shape.windows)) {
      for (const seat of seats) this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
    }
  }
  seedInterruptedCouncilMigration(): void {
    this.shape = {
      sessions: [TXD_SESSION],
      windows: {
        ...Object.fromEntries(Object.entries(TXD_WINDOWS).map(([page, seats]) => [page, [...seats]])),
        mechanicus: [...PREVIOUS_WINDOWS.mechanicus],
      },
    };
    for (const seats of Object.values(this.shape.windows)) {
      for (const seat of seats) this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
    }
  }
  async createSeat(seatId: string): Promise<void> {
    // Test control: a configured seat throws (simulates a below-membrane tmux
    // failure), exercising the constructor's per-seat isolation.
    if (this.failCreate.has(seatId)) throw new Error(`FakeTmux: forced createSeat failure for ${seatId}`);
    this.seats.set(seatId, { pane: 'live', generation: crypto.randomUUID() });
  }
  /** Test control: force createSeat(seatId) to throw. */
  failCreateSeat(seatId: string): void {
    this.failCreate.add(seatId);
  }
  async killSeat(seatId: string): Promise<void> {
    const s = this.seats.get(seatId);
    if (s) s.pane = 'dead';
  }
  async reapSeat(seatId: string, previousTint?: string | null): Promise<boolean> {
    // Respawn keeps the pane LIVE (bare shell) — a live seat is reapable; a dead
    // or missing pane is not (nothing to respawn without a teardown+recreate).
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return false;
    const tintToRestore = previousTint === undefined
      ? this.tints.get(seatId) ?? null
      : previousTint;
    if (this.tintClearFailures.has(seatId)) return false;
    this.tints.delete(seatId);
    if (this.failReap.has(seatId)) {
      if (tintToRestore !== null) this.tints.set(seatId, tintToRestore);
      return false;
    }
    s.pane = 'live';
    return true;
  }
  async resetSeat(seatId: string): Promise<boolean> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return false;
    s.pane = 'live';
    this.commands.delete(seatId);
    this.tints.delete(seatId);
    this.resets.push(seatId);
    return true;
  }
  resetSeats(): string[] { return [...this.resets]; }
  async rebuildPage(page: string): Promise<boolean> {
    if (!Object.hasOwn(TXD_WINDOWS, page)) return false;
    const seats = [...TXD_WINDOWS[page as keyof typeof TXD_WINDOWS]];
    this.shape.sessions = [TXD_SESSION];
    this.shape.windows[page] = seats;
    for (const [seat] of this.seats) if (seat.startsWith(`${page}:`)) this.seats.delete(seat);
    for (const [seat] of this.staticAgents) if (seat.startsWith(`${page}:`)) this.staticAgents.delete(seat);
    for (const [seat] of this.tints) if (seat.startsWith(`${page}:`)) this.tints.delete(seat);
    for (const seat of seats) {
      this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
      this.commands.delete(seat);
    }
    this.pageRebuilds.push(page);
    return true;
  }
  async startStaticAgent(launch: StaticAgentLaunch): Promise<boolean> {
    if (this.staticStartFailures.has(launch.seatId)) return false;
    const seat = this.seats.get(launch.seatId);
    if (!seat || seat.pane === 'dead') return false;
    const ordinal = this.staticAgents.size + 1;
    this.staticAgents.set(launch.seatId, {
      wrapperPid: 10_000 + ordinal,
      enginePid: 20_000 + ordinal,
      engine: launch.engine,
      launch,
    });
    this.commands.set(launch.seatId, launch.engine);
    return true;
  }
  failStaticAgentStart(seatId: string): void { this.staticStartFailures.add(seatId); }
  staticAgent(seatId: string) {
    return this.staticAgents.get(seatId);
  }
  async attestStaticAgent(
    seatId: string,
    wrapperPid: number,
    enginePid: number,
    engine: 'claude' | 'codex',
    engineExecutable: string,
  ): Promise<boolean> {
    const agent = this.staticAgents.get(seatId);
    return agent?.wrapperPid === wrapperPid
      && agent.enginePid === enginePid
      && agent.engine === engine
      && engineExecutable === `/sanctioned/${engine}`;
  }
  async setSeatTint(seatId: string, tint: string | null): Promise<boolean> {
    const seat = this.seats.get(seatId);
    if (!seat || seat.pane === 'dead') return false;
    if (tint === null && this.tintClearFailures.has(seatId)) return false;
    if (tint !== null && this.tintFailures.has(seatId)) return false;
    if (tint !== null && this.tintMisapplications.has(seatId)) {
      this.tints.set(seatId, '#000000');
      return false;
    }
    if (tint === null) this.tints.delete(seatId);
    else this.tints.set(seatId, tint);
    return true;
  }
  async seatTint(seatId: string): Promise<string | null | undefined> {
    const seat = this.seats.get(seatId);
    if (!seat || seat.pane === 'dead') return undefined;
    return this.tints.get(seatId) ?? null;
  }
  async seatGeneration(seatId: string): Promise<string | undefined> {
    return this.seats.get(seatId)?.generation;
  }
  failTintSeat(seatId: string): void { this.tintFailures.add(seatId); }
  failTintClearSeat(seatId: string): void { this.tintClearFailures.add(seatId); }
  misapplyTintSeat(seatId: string): void { this.tintMisapplications.add(seatId); }
  forceSeatTint(seatId: string, tint: string | null): void {
    if (tint === null) this.tints.delete(seatId);
    else this.tints.set(seatId, tint);
  }
  forceSeatGeneration(seatId: string, generation: string): void {
    const seat = this.seats.get(seatId);
    if (seat) seat.generation = generation;
  }
  rebuiltPages(): string[] { return [...this.pageRebuilds]; }
  /** Test control: force reapSeat(seatId) to fail (simulates a wedged process). */
  failReapSeat(seatId: string): void {
    this.failReap.add(seatId);
  }
  /** Test control: kill a pane out-of-band (simulates a raw tmux kill). */
  killOutOfBand(seatId: string): void {
    const s = this.seats.get(seatId);
    if (s) s.pane = 'dead';
  }
  /** Test control: remove a pane out-of-band (simulates tmux deleting a terminal). */
  deleteOutOfBand(seatId: string): void {
    this.seats.delete(seatId);
    const [page] = seatId.split(':', 1);
    if (!page) return;
    const seats = this.shape.windows[page];
    if (seats) this.shape.windows[page] = seats.filter((seat) => seat !== seatId);
  }
  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return { bytes: 0, verdict: 'failed_none_delivered' };
    return { bytes: Buffer.byteLength(text, 'utf8'), verdict: 'delivered' };
  }
}
