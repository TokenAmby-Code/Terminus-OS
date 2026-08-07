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
import { open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
export type SeatEngineLaunch = {
  seatId: string;
  engine: 'claude' | 'codex';
  wrapper: string;
  // Identity rides launch composition, never the birth reply: registrationd
  // mints AGENT_ID at dispatch and txd sets it on the pane environment. Every
  // launch is a dispatch, perpetual seats included, so every launch has one —
  // there is no way to start an engine in this estate without saying who it
  // is.
  agentId: string;
  // Per-launch correlation minted by txd; the wrapper echoes it in
  // wrapper_start and, on an ssh seat, names the remote envelope with it.
  launchNonce: string;
  // The seat's declared target machine alias; absent for a local seat.
  sshTarget?: string;
  // The orders the dispatch carried, handed to the engine as its opening
  // prompt. Absent for a bodiless dispatch. It travels as one argv element so
  // a brief keeps its backticks, blank lines and `$` byte-for-byte; nothing
  // between here and the engine re-quotes it.
  prompt?: string;
};
export type WrapperPlacementAttestation =
  | {
      ok: true;
      pane_id: string;
      pane_generation: string;
      wrapper_pid: number;
      pane_root_pid: number;
      ancestry: number[];
      process_start_ticks: Record<string, string>;
    }
  | {
      ok: false;
      reason:
        | 'wrapper_process_missing'
        | 'wrapper_not_in_managed_pane'
        | 'pane_dead'
        | 'pane_generation_missing'
        | 'ambiguous_placement'
        | 'process_changed';
    };

// Below-membrane STAGING outcome (discriminated by verdict). tmux can prove it
// put bytes in a pane and pressed Enter; it cannot prove the engine consumed
// them. A busy composer queues input and submits it whenever its current turn
// ends, so no observation available here distinguishes submitted from queued.
// Submission is a fact of the receiving engine — its UserPromptSubmit hook,
// which txd folds into `act.comm_delivery_asserted`. That is the only fact
// permitted to mean delivered, and no verdict here may spell that word.
export type SendOutcome =
  | { verdict: 'staged'; bytes: number }
  | { verdict: 'failed_none_delivered'; bytes: 0 };

// The redrive verdicts obey the same membrane: 'enter_redriven' says a parked,
// verified-intact frame was submitted with one Enter — it still does not say
// delivered. The other verdicts are refusals to type blind.
export type ComposerVerdict = 'intact' | 'corrupted' | 'absent';
export type CommRedriveDriveOutcome = 'enter_redriven' | 'composer_corrupted' | 'frame_absent' | 'seat_unresolved';

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
  /** Replace a seat's process with the sanctioned wrapper running the named engine. */
  startSeatEngine(launch: SeatEngineLaunch): Promise<boolean>;
  /** Apply or clear the persona tint and verify both pane-local tmux style options. */
  setSeatTint(seatId: string, tint: string | null): Promise<boolean>;
  /** Observe the verified pane-local tint; undefined means absent/unreadable, null means fail-dark. */
  seatTint(seatId: string): Promise<string | null | undefined>;
  /** Observe txd's opaque physical pane generation (never a raw tmux handle). */
  seatGeneration(seatId: string): Promise<string | undefined>;
  /** Resolve a wrapper PID to canonical pane truth through /proc ancestry and tmux witnesses. */
  attestWrapperPlacement(wrapperPid: number): Promise<WrapperPlacementAttestation>;
  /** Type text into the seat's pane. Reports full/partial/none delivery. Resolves %id below the membrane. */
  sendToSeat(seatId: string, text: string): Promise<SendOutcome>;
  sendVerifiedToSeat(seatId: string, correlationId: string, text: string, tabAfterPrefix?: string): Promise<SendOutcome | { verdict: 'composer_corrupted' | 'frame_absent' | 'seat_unresolved'; bytes: number }>;
  /** Observe whether the live engine composer is painted without pane input. */
  observeComposerInteractive(seatId: string): Promise<boolean>;
  /**
   * Re-drive a parked comm frame with a single Enter — never by retyping.
   * Enter fires only when the visible composer holds the frame AND its text
   * verifies intact against the exact payload that was staged; a corrupted
   * composer is refused (submitting mangled text is worse than failing loud).
   */
  redriveSeatComm(seatId: string, messageId: string, expectedFrame: string): Promise<CommRedriveDriveOutcome>;
  /**
   * Observe whether an engine process for `agentId` is running under this
   * seat's pane, RIGHT NOW. The turn fold cannot answer this — nothing in it
   * watches a process — so a destructive act asks the operating system instead.
   *
   * Tri-state on purpose. On an ssh seat the pane's child is the TUNNEL and the
   * engine runs on the far side, where this machine cannot see it; answering
   * `dead` there would reap healthy remote agents, which is the very defect
   * this guard exists to remove. An unobservable seat says so.
   */
  agentLiveness(seatId: string, agentId: string): Promise<AgentLiveness>;
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

// The declared split placing each seat, mirrored from constructPage's
// construction graph: the sibling whose edge the seat shares, the split
// orientation, and the declared share where the default even split would not
// restore it (the full-height flank columns hold 30% of the window by
// construction). repairSeat re-runs exactly this split to put a killed seat
// back without touching any survivor.
const REPAIR_SPLITS: Record<string, { source: string; flags: string[]; size?: string }> = {
  'reservists:W': { source: 'reservists:N', flags: ['-f', '-h', '-b'], size: '30%' },
  'reservists:N': { source: 'reservists:S', flags: ['-v', '-b'] },
  'reservists:S': { source: 'reservists:N', flags: ['-v'] },
  'reservists:E': { source: 'reservists:N', flags: ['-f', '-h'], size: '30%' },
  'palace:W': { source: 'palace:N', flags: ['-f', '-h', '-b'], size: '30%' },
  'palace:N': { source: 'palace:S', flags: ['-v', '-b'] },
  'palace:S': { source: 'palace:N', flags: ['-v'] },
  'palace:E': { source: 'palace:N', flags: ['-f', '-h'], size: '30%' },
  'somnium:W': { source: 'somnium:N', flags: ['-f', '-h', '-b'], size: '30%' },
  'somnium:N': { source: 'somnium:S', flags: ['-v', '-b'] },
  'somnium:S': { source: 'somnium:N', flags: ['-v'] },
  'somnium:NE': { source: 'somnium:SE', flags: ['-v', '-b'] },
  'somnium:SE': { source: 'somnium:NE', flags: ['-v'] },
  'council:custodes': { source: 'council:fabricator-general', flags: ['-v', '-b'] },
  'council:fabricator-general': { source: 'council:custodes', flags: ['-v'] },
  'council:pax': { source: 'council:orchestrator', flags: ['-v', '-b'] },
  'council:orchestrator': { source: 'council:pax', flags: ['-v'] },
};

const CANON_OPT = '@canonical_id';
const GENERATION_OPT = '@txd_generation';
const PANE_ID_ENV = 'PANE_ID';
const AGENT_ID_ENV = 'AGENT_ID';
const LAUNCH_NONCE_ENV = 'TXD_LAUNCH_NONCE';
const SSH_TARGET_ENV = 'TXD_SSH_TARGET';
const MACHINE_ENV = 'IMPERIUM_MACHINE';
const MAX_PROCESS_ANCESTRY = 256;
type ProcessWitness = { pid: number; parent_pid: number; start_ticks: string };

async function processWitness(pid: number): Promise<ProcessWitness | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const parent_pid = Number(fields[1]);
    const start_ticks = fields[19];
    if (!Number.isInteger(parent_pid) || parent_pid < 0 || !start_ticks) return null;
    return { pid, parent_pid, start_ticks };
  } catch {
    return null;
  }
}

const ENGINE_COMMANDS = new Set(['claude', 'codex']);

/**
 * What this machine can honestly say about an agent's engine.
 *
 * `unobservable` is not a failure to try — it is the correct answer for a seat
 * whose engine runs somewhere this process cannot look. A caller about to do
 * something irreversible must treat it as "do not proceed", never as "dead".
 */
export type AgentLiveness = 'alive' | 'dead' | 'unobservable';

/** One variable from a process's own environment block. */
async function processEnv(pid: number, name: string): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, 'utf8');
    for (const entry of raw.split('\0')) {
      const split = entry.indexOf('=');
      if (split > 0 && entry.slice(0, split) === name) return entry.slice(split + 1);
    }
    return null;
  } catch {
    return null;
  }
}

const processAgentId = (pid: number): Promise<string | null> => processEnv(pid, AGENT_ID_ENV);

/** A process's direct children, from the kernel's own view of the tree. */
async function processChildren(pid: number): Promise<number[]> {
  try {
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return raw.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {
    return [];
  }
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function processAncestry(pid: number): Promise<ProcessWitness[] | null> {
  const out: ProcessWitness[] = [];
  const seen = new Set<number>();
  let current = pid;
  while (current > 0 && out.length < MAX_PROCESS_ANCESTRY && !seen.has(current)) {
    seen.add(current);
    const witness = await processWitness(current);
    if (!witness) return null;
    out.push(witness);
    if (witness.parent_pid === 0 || witness.parent_pid === current) break;
    current = witness.parent_pid;
  }
  return out;
}
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
type WriteClient = (path: string, data: Uint8Array) => Promise<void>;
type PaneOutputSubscription = { next(signal: AbortSignal): Promise<void>; close(): void };
type PaneOutputObserver = (socket: string, paneId: string, signal: AbortSignal) => Promise<PaneOutputSubscription>;

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

function spawnTmuxProcess(
  socket: string,
  args: string[],
  options: { stdin?: 'pipe' | undefined; stdout: 'pipe'; stderr: 'pipe' },
) {
  return Bun.spawn(['tmux', '-L', socket, ...args], options);
}

async function spawnTmux(
  socket: string,
  args: string[],
  stdin?: Uint8Array,
  stdoutLimit = 8 * 1024 * 1024,
): Promise<TmuxBinaryResult> {
  const proc = spawnTmuxProcess(socket, args, {
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

async function observePaneOutput(
  socket: string,
  paneId: string,
  signal: AbortSignal,
): Promise<PaneOutputSubscription> {
  // A pane-targeted attach selects that pane globally in its window, stealing
  // focus from every existing client. Attach the observer to the containing
  // session instead; control mode still emits pane-qualified %output facts,
  // which we filter against paneId below.
  const session = await spawnTmux(socket, [
    'display-message', '-p', '-t', paneId, '#{session_id}',
  ]);
  const sessionId = new TextDecoder().decode(session.stdout).trim();
  if (session.code !== 0 || session.overflow || !sessionId) {
    throw new Error('tmux pane session could not be resolved');
  }
  const proc = spawnTmuxProcess(socket, ['-C', 'attach-session', '-t', sessionId], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let queued = 0;
  let closed = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    readyReject(error);
    for (const waiter of waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
    }
  };
  const emit = () => {
    const waiter = waiters.shift();
    if (!waiter) {
      queued += 1;
      return;
    }
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  };

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline).replace(/\r$/, '');
          buffered = buffered.slice(newline + 1);
          if (line.startsWith('%session-changed ')) readyResolve();
          if (line.startsWith(`%output ${paneId} `)) emit();
          newline = buffered.indexOf('\n');
        }
      }
      fail(new Error('tmux control client exited'));
    } catch (error) {
      fail(error instanceof Error ? error : new Error('tmux control client failed'));
    } finally {
      reader.releaseLock();
    }
  })();

  const abortReady = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('pane output observation timed out'));
    else signal.addEventListener('abort', () => reject(new Error('pane output observation timed out')), { once: true });
  });
  try {
    await Promise.race([ready, abortReady]);
  } catch (error) {
    closed = true;
    proc.stdin!.end();
    proc.kill();
    await reader.cancel();
    throw error;
  }

  return {
    next(nextSignal) {
      if (queued > 0) {
        queued -= 1;
        return Promise.resolve();
      }
      if (closed) return Promise.reject(new Error('tmux control client exited'));
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal: nextSignal,
          abort: () => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error('pane output observation timed out'));
          },
        };
        if (nextSignal.aborted) waiter.abort();
        else {
          nextSignal.addEventListener('abort', waiter.abort, { once: true });
          waiters.push(waiter);
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(new Error('tmux control client closed'));
      }
      proc.stdin!.write('detach-client\n');
      proc.stdin!.end();
    },
  };
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
  private binaryRunner: TmuxBinaryRunner;
  private writeClient: WriteClient;
  private machine: string | undefined;
  private outputObserver: PaneOutputObserver;
  private composerObserveTimeoutMs: number;

  constructor(
    private socket: string,
    options: {
      run?: TmuxRunner;
      runBytes?: TmuxBinaryRunner;
      writeClient?: WriteClient;
      audit?: AuditSink;
      machine?: string;
      observePaneOutput?: PaneOutputObserver;
      composerObserveTimeoutMs?: number;
    } = {},
  ) {
    this.runner = options.run ?? run;
    this.binaryRunner = options.runBytes ?? runBytes;
    this.audit = options.audit ?? ((record) => console.info(JSON.stringify({ level: 'info', event: 'tmux_operation', ...record })));
    this.writeClient = options.writeClient ?? (async (path, data) => {
      const handle = await open(path, 'w');
      try {
        await handle.write(data);
      } finally {
        await handle.close();
      }
    });
    this.machine = options.machine;
    this.outputObserver = options.observePaneOutput ?? observePaneOutput;
    this.composerObserveTimeoutMs = options.composerObserveTimeoutMs ?? 10_000;
  }

  private paneEnvironment(seatId: string): string[] {
    const environment = ['-e', `${PANE_ID_ENV}=${seatId}`];
    if (this.machine) environment.push('-e', `${MACHINE_ENV}=${this.machine}`);
    return environment;
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

  /**
   * Stage one opaque text segment as a tmux bracketed paste.
   *
   * `send-keys -l` translates a string into one terminal key event per
   * codepoint. Interactive TUIs may consume only a prefix of a sufficiently
   * large burst even though tmux exits zero. Loading bytes over stdin and
   * pasting the named buffer writes the complete segment directly to the pane
   * as one bracketed-paste event. The buffer name is private, unique, and
   * deleted by the successful paste; a failed paste is cleaned explicitly.
   */
  private async pasteLiteral(
    seatId: string,
    paneId: string,
    text: string,
    operation: string,
  ): Promise<boolean> {
    if (text.length === 0) return true;
    const bufferName = `txd-input-${randomUUID()}`;
    const bytes = new TextEncoder().encode(text);
    const loaded = await this.command(`${operation}_load`, seatId, [
      'load-buffer', '-b', bufferName, '-',
    ], bytes);
    if (loaded.code !== 0) return false;
    const pasted = await this.command(operation, seatId, [
      'paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', paneId,
    ]);
    if (pasted.code === 0) return true;
    await this.command(`${operation}_cleanup`, seatId, ['delete-buffer', '-b', bufferName]);
    return false;
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

  /**
   * One observation, taken at the moment it is needed: is an engine for this
   * agent running under this seat's pane?
   *
   * This is not a poll. A poll asks repeatedly because an event it should have
   * received never arrives. This asks once, immediately before an irreversible
   * act, because the recorded turn fold is inference about the PAST and a close
   * needs the PRESENT. `awaiting_input` is the normal resting state of a healthy
   * agent, so gating a close on the fold alone reaps live workers.
   *
   * Both halves must hold: an engine command, and that engine's own AGENT_ID
   * matching. A pane running a bare shell is not the agent, and an engine
   * carrying a different identity is a different agent in a reused seat.
   */
  async agentLiveness(seatId: string, agentId: string): Promise<AgentLiveness> {
    if (!agentId) return 'unobservable';
    const observed = await this.command('observe_pane_pid', seatId, [
      'list-panes', '-a', '-F', `#{${CANON_OPT}}\t#{pane_pid}`,
    ]);
    // Only tmux's own answer can establish absence. If we cannot ask, we do
    // not know — and not knowing must never license a close.
    if (observed.code !== 0) return 'unobservable';
    const panePid = observed.stdout.split('\n').flatMap((line) => {
      const [canonical, rawPid] = line.split('\t');
      return canonical === seatId && rawPid ? [Number(rawPid)] : [];
    })[0];
    // The seat has no pane at all. That is a POSITIVE observation of absence:
    // there is nothing left to be running, so the agent is dead.
    if (panePid === undefined) return 'dead';
    if (!Number.isInteger(panePid)) return 'unobservable';

    // Walk the pane's descendants. The wrapper BACKGROUNDS the engine rather
    // than exec-ing it, so a fixed depth would be a guess; following the tree
    // is not.
    let frontier = [panePid];
    const visited = new Set<number>(frontier);
    while (frontier.length > 0) {
      for (const pid of frontier) {
        const command = await processCommand(pid);
        if (command && ENGINE_COMMANDS.has(command) && await processAgentId(pid) === agentId) return 'alive';
      }
      const children = await Promise.all(frontier.map((pid) => processChildren(pid)));
      frontier = children.flat().filter((pid) => !visited.has(pid) && visited.add(pid));
    }

    // The pane EXISTS but no matching local engine was found. That is not
    // evidence of death, and it is reached by several very different worlds:
    //
    //   - an ssh seat, whose wrapper runs the engine in a REMOTE tmux envelope,
    //     so the local descendants are a tunnel by construction (council:
    //     orchestrator carries no TXD_SSH_TARGET at all, so no marker can be
    //     trusted to identify these);
    //   - an unreadable /proc entry, a permissions refusal, or a tmux hiccup;
    //   - an engine whose comm is renamed, added, or truncated by /proc's
    //     15-character limit, which ENGINE_COMMANDS would not recognise;
    //   - an agent mid-launch whose engine has not exec'd yet.
    //
    // Every one of those is a live-or-unknown agent, and answering 'dead'
    // reaps it. Absence of proof is not proof of absence: this says so.
    return 'unobservable';
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
    return this.checked(args.includes('-c') ? args : [...args, '-c', this.homeDirectory()], operation, target);
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

  private async defaultShell(target: string): Promise<string | null> {
    const observed = await this.command('observe_default_shell', target, [
      'show-options', '-gv', 'default-shell',
    ]);
    const shell = observed.stdout.trim();
    if (observed.code !== 0 || !shell.startsWith('/')) return null;
    return shell;
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
    const seats = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS];
    const first = seed ?? await this.estateChecked(
      ['new-window', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[0]!), '-c', this.homeDirectory(), '-t', TXD_SESSION, '-n', page],
      `create ${page} window`,
      page,
    );
    let panes: string[];
    if (page === 'reservists' || page === 'palace') {
      const center = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[1]!), '-c', this.homeDirectory(), '-l', '70%', '-t', first], `split ${page} center`, page);
      const east = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[3]!), '-c', this.homeDirectory(), '-l', '43%', '-t', center], `split ${page} east`, page);
      const south = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[2]!), '-c', this.homeDirectory(), '-l', '50%', '-t', center], `split ${page} south`, page);
      panes = [first, center, south, east];
    } else if (page === 'somnium') {
      const north = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[1]!), '-c', this.homeDirectory(), '-l', '70%', '-t', first], 'split somnium grid', page);
      const northeast = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[3]!), '-c', this.homeDirectory(), '-l', '50%', '-t', north], 'split somnium east column', page);
      const south = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[2]!), '-c', this.homeDirectory(), '-l', '50%', '-t', north], 'split somnium south', page);
      const southeast = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[4]!), '-c', this.homeDirectory(), '-l', '50%', '-t', northeast], 'split somnium southeast', page);
      panes = [first, north, south, northeast, southeast];
    } else if (page === 'council') {
      const northeast = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[2]!), '-c', this.homeDirectory(), '-l', '50%', '-t', first],
        'split council east column',
        page,
      );
      const southwest = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[1]!), '-c', this.homeDirectory(), '-l', '50%', '-t', first],
        'split council southwest',
        page,
      );
      const southeast = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[3]!), '-c', this.homeDirectory(), '-l', '50%', '-t', northeast],
        'split council southeast',
        page,
      );
      panes = [first, southwest, northeast, southeast];
    } else {
      throw new Error(`txd refused unknown page ${page}`);
    }
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
          const shellCommand = await this.defaultShell(page);
          if (!shellCommand) return false;
          if ((await this.command('reset_page_seed', page, [
            'respawn-pane', '-k', '-c', this.homeDirectory(),
            ...this.paneEnvironment(TXD_WINDOWS[page as keyof typeof TXD_WINDOWS][0]!),
            '-t', seed, '/usr/bin/env',
            `${PANE_ID_ENV}=${TXD_WINDOWS[page as keyof typeof TXD_WINDOWS][0]!}`,
            shellCommand,
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
      for (const seat of TXD_ESTATE) {
        try {
          await this.ensureSeatGeneration(seat);
        } catch {
          const page = seat.split(':', 1)[0]!;
          throw new Error(
            `txd could not drive canonical page ${page} to canonical shape: ${this.describePage(page, await this.estateRows())}`,
          );
        }
      }
      return { state: 'existing', rebuilt_pages };
    }

    let sessionCreated = false;
    try {
      const reservistsW = await this.estateChecked(
        ['new-session', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('reservists:W'), '-c', this.homeDirectory(), '-s', TXD_SESSION, '-n', 'reservists', '-x', '200', '-y', '60'],
        'create canonical session',
      );
      sessionCreated = true;
      const reservistsN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('reservists:N'), '-c', this.homeDirectory(), '-l', '70%', '-t', reservistsW], 'split reservists center');
      const reservistsE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('reservists:E'), '-c', this.homeDirectory(), '-l', '43%', '-t', reservistsN], 'split reservists east');
      const reservistsS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('reservists:S'), '-c', this.homeDirectory(), '-l', '50%', '-t', reservistsN], 'split reservists south');
      await Promise.all([
        this.tag(reservistsW, 'reservists:W'), this.tag(reservistsN, 'reservists:N'),
        this.tag(reservistsS, 'reservists:S'), this.tag(reservistsE, 'reservists:E'),
      ]);

      const palaceW = await this.estateChecked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('palace:W'), '-c', this.homeDirectory(), '-t', TXD_SESSION, '-n', 'palace'],
        'create palace window',
      );
      const palaceN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('palace:N'), '-c', this.homeDirectory(), '-l', '70%', '-t', palaceW], 'split palace center');
      const palaceE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('palace:E'), '-c', this.homeDirectory(), '-l', '43%', '-t', palaceN], 'split palace east');
      const palaceS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('palace:S'), '-c', this.homeDirectory(), '-l', '50%', '-t', palaceN], 'split palace south');
      await Promise.all([
        this.tag(palaceW, 'palace:W'), this.tag(palaceN, 'palace:N'),
        this.tag(palaceS, 'palace:S'), this.tag(palaceE, 'palace:E'),
      ]);

      const somniumW = await this.estateChecked(['new-window', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('somnium:W'), '-c', this.homeDirectory(), '-t', TXD_SESSION, '-n', 'somnium'], 'create somnium window');
      const somniumN = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('somnium:N'), '-c', this.homeDirectory(), '-l', '70%', '-t', somniumW], 'split somnium grid');
      const somniumNE = await this.estateChecked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('somnium:NE'), '-c', this.homeDirectory(), '-l', '50%', '-t', somniumN], 'split somnium east column');
      const somniumS = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('somnium:S'), '-c', this.homeDirectory(), '-l', '50%', '-t', somniumN], 'split somnium south');
      const somniumSE = await this.estateChecked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('somnium:SE'), '-c', this.homeDirectory(), '-l', '50%', '-t', somniumNE], 'split somnium southeast');
      await Promise.all([
        this.tag(somniumW, 'somnium:W'), this.tag(somniumN, 'somnium:N'),
        this.tag(somniumS, 'somnium:S'), this.tag(somniumNE, 'somnium:NE'), this.tag(somniumSE, 'somnium:SE'),
      ]);

      const council = await this.estateChecked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:custodes'), '-c', this.homeDirectory(), '-t', TXD_SESSION, '-n', 'council'],
        'create council window',
      );
      const councilNE = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:pax'), '-c', this.homeDirectory(), '-l', '50%', '-t', council],
        'split council east column',
      );
      const councilSW = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:fabricator-general'), '-c', this.homeDirectory(), '-l', '50%', '-t', council],
        'split council southwest',
      );
      const councilSE = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:orchestrator'), '-c', this.homeDirectory(), '-l', '50%', '-t', councilNE],
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
    const created = await this.command('create_seat', seatId, [
      'new-session', '-d', ...this.paneEnvironment(seatId), '-s', safe, '-x', '200', '-y', '50', '-c', this.homeDirectory(),
    ]);
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
    const shell = await this.defaultShell(seatId);
    if (!shell) return false;
    // Clear and attest the identity signal before killing the bound process.
    // If respawn then fails, restore the still-current binding's physical style.
    if (!(await this.setSeatTint(seatId, null))) return false;
    // -k kills the pane's current command while reusing the pane and its
    // @canonical_id option. tmux 3.5a does not preserve the pane-local
    // environment across respawn, so the physical authority must restamp the
    // same canonical PANE_ID on every replacement process.
    const r = await this.command('reap_seat', seatId, [
      'respawn-pane', '-k', ...this.paneEnvironment(seatId), '-t', paneId,
      '/usr/bin/env', `${PANE_ID_ENV}=${seatId}`, shell,
    ]);
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
    if (!paneId) return this.repairSeat(seatId);
    const shell = await this.defaultShell(seatId);
    if (!shell) return false;
    if ((await this.command('clear_seat_history', seatId, ['clear-history', '-t', paneId])).code !== 0) return false;
    if ((await this.command('reset_seat_process', seatId, [
      'respawn-pane', '-k', ...this.paneEnvironment(seatId), '-t', paneId,
      '/usr/bin/env', `${PANE_ID_ENV}=${seatId}`, shell,
    ])).code !== 0) return false;
    const verified = await this.command('verify_reset_seat_tag', seatId, ['display-message', '-p', '-t', paneId, `#{${CANON_OPT}}`]);
    return verified.code === 0 && verified.stdout.trim() === seatId && await this.setSeatTint(seatId, null);
  }

  /**
   * Recreate a KILLED seat's pane in place: split a surviving pane in the
   * seat's window, tag the new pane with the canonical id, and clear its
   * tint. The split source and direction come from the same declared
   * construction graph constructPage stands, so a repaired seat lands in its
   * declared position; when the declared source is itself gone, any surviving
   * tagged pane anchors the split and boot-time convergence owns exactness.
   * Returns false only when the window has no tagged pane left to anchor a
   * repair — that page is structure damage, not a pane fault.
   */
  private async repairSeat(seatId: string): Promise<boolean> {
    const [page] = seatId.split(':', 1);
    if (!page || !Object.hasOwn(TXD_WINDOWS, page)) return false;
    const seats = TXD_WINDOWS[page as keyof typeof TXD_WINDOWS] as readonly string[];
    if (!seats.includes(seatId)) return false;
    const target = `${TXD_SESSION}:${page}`;
    const listed = await this.command('observe_page_panes', page, [
      'list-panes', '-t', target, '-F', `#{pane_id}\t#{${CANON_OPT}}\t#{pane_dead}`,
    ]);
    if (listed.code !== 0) return false;
    const anchors = new Map<string, string>();
    for (const line of listed.stdout.split('\n')) {
      const [pane, canon, dead] = line.split('\t');
      if (pane && canon && dead === '0' && !anchors.has(canon)) anchors.set(canon, pane);
    }
    if (anchors.size === 0) return false;
    if (!(await this.clearPageZoom(page, target))) return false;
    const spec = REPAIR_SPLITS[seatId];
    const sourcePane = (spec && anchors.get(spec.source)) ?? [...anchors.values()][0]!;
    const flags = spec && anchors.has(spec.source)
      ? [...spec.flags, ...(spec.size ? ['-l', spec.size] : [])]
      : ['-h'];
    try {
      const created = await this.estateChecked(
        ['split-window', ...flags, '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seatId), '-t', sourcePane],
        `repair ${seatId}`,
        seatId,
      );
      await this.tag(created, seatId);
      const verified = await this.command('verify_repair_seat_tag', seatId, ['display-message', '-p', '-t', created, `#{${CANON_OPT}}`]);
      return verified.code === 0 && verified.stdout.trim() === seatId && await this.setSeatTint(seatId, null);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'seat_repair_failed', seat: seatId, error: String(error) }));
      return false;
    }
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
  }

  async startSeatEngine(launch: SeatEngineLaunch): Promise<boolean> {
    const paneId = await this.resolvePane(launch.seatId);
    if (!paneId) return false;
    const environment = [
      `${PANE_ID_ENV}=${this.shellQuote(launch.seatId)}`,
      `${AGENT_ID_ENV}=${this.shellQuote(launch.agentId)}`,
      `${LAUNCH_NONCE_ENV}=${this.shellQuote(launch.launchNonce)}`,
      ...(launch.sshTarget ? [`${SSH_TARGET_ENV}=${this.shellQuote(launch.sshTarget)}`] : []),
    ].join(' ');
    const command = [
      `exec /usr/bin/env ${environment}`,
      this.shellQuote(launch.wrapper),
      this.shellQuote(launch.engine),
      ...(launch.prompt === undefined ? [] : [this.shellQuote(launch.prompt)]),
    ].join(' ');
    const result = await this.command('start_seat_engine', launch.seatId, [
      'respawn-pane', '-k',
      ...this.paneEnvironment(launch.seatId), '-t', paneId, command,
    ]);
    return result.code === 0;
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

  async attestWrapperPlacement(wrapperPid: number): Promise<WrapperPlacementAttestation> {
    const ancestry = await processAncestry(wrapperPid);
    if (!ancestry) return { ok: false, reason: 'wrapper_process_missing' };
    const byPid = new Map(ancestry.map((witness) => [witness.pid, witness]));
    const listed = await this.command('attest_wrapper_placement', 'wrapper-process', [
      'list-panes', '-a', '-F',
      `#{${CANON_OPT}}\t#{pane_pid}\t#{pane_dead}\t#{${GENERATION_OPT}}`,
    ]);
    if (listed.code !== 0) return { ok: false, reason: 'wrapper_not_in_managed_pane' };
    const candidates = listed.stdout.split('\n').filter(Boolean).flatMap((line) => {
      const [pane_id, rawPid, dead, pane_generation] = line.split('\t');
      const pane_root_pid = Number(rawPid);
      return pane_id && Number.isInteger(pane_root_pid) && byPid.has(pane_root_pid)
        ? [{ pane_id, pane_root_pid, dead, pane_generation: pane_generation ?? '' }]
        : [];
    });
    if (candidates.length === 0) return { ok: false, reason: 'wrapper_not_in_managed_pane' };
    if (candidates.length !== 1) return { ok: false, reason: 'ambiguous_placement' };
    const candidate = candidates[0]!;
    if (candidate.dead === '1') return { ok: false, reason: 'pane_dead' };
    if (!candidate.pane_generation) return { ok: false, reason: 'pane_generation_missing' };

    const [wrapperAfter, rootAfter] = await Promise.all([
      processWitness(wrapperPid),
      processWitness(candidate.pane_root_pid),
    ]);
    if (!wrapperAfter || !rootAfter
        || wrapperAfter.start_ticks !== byPid.get(wrapperPid)?.start_ticks
        || rootAfter.start_ticks !== byPid.get(candidate.pane_root_pid)?.start_ticks) {
      return { ok: false, reason: 'process_changed' };
    }
    return {
      ok: true,
      pane_id: candidate.pane_id,
      pane_generation: candidate.pane_generation,
      wrapper_pid: wrapperPid,
      pane_root_pid: candidate.pane_root_pid,
      ancestry: ancestry.map((witness) => witness.pid),
      process_start_ticks: Object.fromEntries(
        ancestry.map((witness) => [String(witness.pid), witness.start_ticks]),
      ),
    };
  }

  async setSeatTint(seatId: string, tint: string | null): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    const style = tint === null ? 'default' : `bg=${tint}`;
    const [inactive, active] = await Promise.all([
      this.command('set_seat_tint', seatId, [
        'set-option', '-p', '-t', paneId, 'window-style', style,
      ]),
      this.command('set_seat_active_tint', seatId, [
        'set-option', '-p', '-t', paneId, 'window-active-style', style,
      ]),
    ]);
    return inactive.code === 0 && active.code === 0 && await this.seatTint(seatId) === tint;
  }

  /**
   * The composer verdict, pure and pinned: does the visible pane hold this
   * frame, and does it hold it UNCORRUPTED? Chrome glyphs and wrapping are
   * presentation, not payload — both sides are stripped of prompt/border
   * characters and whitespace-collapsed before comparison, so a wrapped frame
   * still verifies while a frame the send-keys race mangled does not.
   */
  static composerVerdict(pane: string, messageId: string, expectedFrame: string): ComposerVerdict {
    const normalize = (text: string) => text.replace(/[│┃›>]/g, '').replace(/\s+/g, '');
    // Both gates read the SAME normalized text: a bordered composer re-flows
    // its own lines (capture -J rejoins only terminal wraps), so the raw pane
    // may split the very header the absence gate looks for.
    const normalized = normalize(pane);
    const expected = normalize(expectedFrame);
    if (normalized.includes(normalize(`tx comm ${messageId}`))) {
      return normalized.includes(expected) ? 'intact' : 'corrupted';
    }

    // Codex's multiline composer is a viewport. Narrow panes can clip the
    // frame's first rows after extra TUI chrome (for example the background
    // terminal status) reduces the textarea height. The last prompt-marked
    // region is still the editor, and an exact, substantial visible suffix is
    // enough to prove that the editor owns the intended bytes. Chrome below
    // the textarea is deliberately ignored by taking only the longest prefix
    // of that region which is an expected-frame suffix.
    const lines = pane.split('\n');
    let promptLine = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\s*[›>]\s?/.test(lines[index]!)) {
        promptLine = index;
        break;
      }
    }
    if (promptLine < 0) return 'absent';

    // Codex deliberately collapses a bracketed multi-KB paste into one native
    // composer receipt instead of painting the payload. tmux has already
    // proven the exact stdin-loaded buffer and atomic paste-buffer operation;
    // this receipt is the engine-side acknowledgement that it accepted that
    // paste. Accept only the whole, otherwise-empty active prompt line and an
    // exact Unicode-scalar count. A lookalike embedded in ordinary payload
    // text, or any count mismatch, remains corruption.
    const collapsedPaste = normalize(lines[promptLine]!).match(/^\[PastedContent(\d+)chars\]$/);
    if (collapsedPaste) {
      return Number(collapsedPaste[1]) === [...expectedFrame].length ? 'intact' : 'corrupted';
    }

    const visibleRegion = normalize(lines.slice(promptLine).join('\n'));
    const minimumProofLength = 32;
    for (let length = visibleRegion.length; length >= minimumProofLength; length -= 1) {
      if (expected.endsWith(visibleRegion.slice(0, length))) return 'intact';
    }
    return 'corrupted';
  }

  static inputVerdict(pane: string, expected: string): ComposerVerdict {
    const normalize = (text: string) => text.replace(/[│┃›>]/g, '').replace(/\s+/g, '');
    return normalize(pane).includes(normalize(expected)) ? 'intact' : 'corrupted';
  }

  static composerInteractive(pane: string): boolean {
    const lines = pane.split('\n');
    const lastContent = lines.reduce((last, line, index) => line.trim() ? index : last, -1);
    if (lastContent < 0) return false;
    const lastPrompt = lines.reduce(
      (last, line, index) => /^\s*[›❯>]\s/.test(line) ? index : last,
      -1,
    );
    const lastAssistantOutput = lines.reduce(
      (last, line, index) => /^\s*[•●⏺]\s/.test(line) ? index : last,
      -1,
    );
    return lastPrompt >= Math.max(0, lastContent - 6) && lastPrompt > lastAssistantOutput;
  }

  async observeComposerInteractive(seatId: string): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    const captured = await this.command('observe_composer_interactive', seatId, [
      'capture-pane', '-p', '-J', '-t', paneId,
    ]);
    return captured.code === 0 && RealTmux.composerInteractive(captured.stdout);
  }

  async redriveSeatComm(seatId: string, messageId: string, expectedFrame: string): Promise<CommRedriveDriveOutcome> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return 'seat_unresolved';
    // Live pane only, joined lines, no scrollback: a parked frame is a LIVE
    // composer state, and transcript history holds the text of every comm
    // ever delivered here — Enter on stale evidence would submit blind.
    const captured = await this.command('observe_comm_composer', seatId, [
      'capture-pane', '-p', '-J', '-t', paneId,
    ]);
    if (captured.code !== 0) return 'seat_unresolved';
    const verdict = expectedFrame.includes(`tx comm ${messageId}`)
      ? RealTmux.composerVerdict(captured.stdout, messageId, expectedFrame)
      : RealTmux.inputVerdict(captured.stdout, expectedFrame);
    if (verdict === 'absent') return 'frame_absent';
    if (verdict === 'corrupted') return 'composer_corrupted';
    const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
    return enter.code === 0 ? 'enter_redriven' : 'seat_unresolved';
  }

  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'failed_none_delivered' };
    const literal = await this.pasteLiteral(seatId, paneId, text, 'paste_literal_unverified');
    if (!literal) return { bytes: 0, verdict: 'failed_none_delivered' };
    const bytes = Buffer.byteLength(text, 'utf8');

    // One discrete Enter, outside the literal burst. If tmux accepted both
    // commands the text is staged in the pane; whether the engine has consumed
    // it is not a question this side can answer, and the answer arrives on its
    // own as `hook.user_prompt_submit`.
    const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
    if (enter.code !== 0) return { bytes: 0, verdict: 'failed_none_delivered' };
    return { bytes, verdict: 'staged' };
  }

  async sendVerifiedToSeat(seatId: string, correlationId: string, text: string, tabAfterPrefix?: string) {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'seat_unresolved' as const };
    const bytes = Buffer.byteLength(text, 'utf8');
    const signal = AbortSignal.timeout(this.composerObserveTimeoutMs);
    let output: PaneOutputSubscription;
    try {
      // Arm the control-mode client before mutation. Its %output facts are the
      // terminal's acknowledgement that the interactive engine repainted;
      // capture is driven by those facts, never by a sleep or polling loop.
      output = await this.outputObserver(this.socket, paneId, signal);
    } catch {
      return { bytes: 0, verdict: 'seat_unresolved' as const };
    }
    let lastVerdict: ComposerVerdict = 'absent';
    try {
      const prefix = tabAfterPrefix ?? text;
      const suffix = tabAfterPrefix === undefined ? '' : text.slice(tabAfterPrefix.length);
      const literal = await this.pasteLiteral(seatId, paneId, prefix, 'paste_literal');
      if (!literal) return { bytes: 0, verdict: 'seat_unresolved' as const };
      if (tabAfterPrefix !== undefined) {
        const tab = await this.command('commit_surface_name', seatId, ['send-keys', '-t', paneId, 'Tab']);
        if (tab.code !== 0) {
          await this.command('restore_input_composer', seatId, ['send-keys', '-t', paneId, '-N', String([...prefix].length), 'BSpace']);
          return { bytes, verdict: 'seat_unresolved' as const };
        }
        if (suffix.length > 0) {
          const argsLiteral = await this.pasteLiteral(seatId, paneId, suffix, 'paste_literal_args');
          if (!argsLiteral) {
            await this.command('restore_input_composer', seatId, ['send-keys', '-t', paneId, '-N', String([...prefix].length), 'BSpace']);
            return { bytes, verdict: 'seat_unresolved' as const };
          }
        }
      }
      // The editor consumes send-keys into its own composer state. If the
      // output-driven verifier cannot prove that exact insertion intact, undo
      // exactly the codepoints this call appended before returning refusal.
      // Retrying may then type once against the same pre-call composer; it can
      // never accumulate another copy of this frame.
      const restoreComposer = async () => {
        const count = [...text].length;
        if (count === 0) return true;
        const restored = await this.command('restore_input_composer', seatId, [
          'send-keys', '-t', paneId, '-N', String(count), 'BSpace',
        ]);
        return restored.code === 0;
      };
      while (!signal.aborted) {
        try {
          await output.next(signal);
        } catch {
          break;
        }
        const captured = await this.command('observe_input_composer', seatId, ['capture-pane', '-p', '-J', '-t', paneId]);
        if (captured.code !== 0) {
          await restoreComposer();
          return { bytes, verdict: 'seat_unresolved' as const };
        }
        lastVerdict = text.includes(`tx comm ${correlationId}`)
          ? RealTmux.composerVerdict(captured.stdout, correlationId, text)
          : RealTmux.inputVerdict(captured.stdout, text);
        if (lastVerdict !== 'intact') continue;
        const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
        if (enter.code === 0) return { bytes, verdict: 'staged' as const };
        await restoreComposer();
        return { bytes, verdict: 'seat_unresolved' as const };
      }
      const restored = await restoreComposer();
      if (!restored) return { bytes, verdict: 'seat_unresolved' as const };
      return lastVerdict === 'absent'
        ? { bytes, verdict: 'frame_absent' as const }
        : { bytes, verdict: 'composer_corrupted' as const };
    } finally {
      output.close();
    }
  }

  // A posed plan is a vendor approval dialog, not a footer state. Claude poses
  // ExitPlanMode as a proceed prompt with numbered options; Codex has no such
  // dialog, so the detector never claims one for it.
  static detectPlanDialog(capture: string, engine: 'claude' | 'codex'): boolean {
    if (engine !== 'claude') return false;
    return /(?:Would you like to proceed\?|Ready to code\?)/.test(capture)
      && /1\.\s*Yes/.test(capture);
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

    if (intent === 'approve_plan') {
      // A posed plan is a LIVE prompt, so the evidence is the visible pane
      // ONLY — no scrollback. Transcript history keeps the text of every plan
      // ever approved on this seat, and accepting on that stale text would
      // send `1` into whatever prompt is live now.
      const observeDialog = () => this.command('observe_plan_dialog', seatId, [
        'capture-pane', '-p', '-J', '-t', paneId,
      ]);
      // With no dialog posed nothing is typed blind — the caller sees an
      // unverified outcome and the failure is loud.
      const posed = await observeDialog();
      if (posed.code !== 0 || !RealTmux.detectPlanDialog(posed.stdout, engine)) {
        return { before, after: before, changed: false, verified: false, mechanism: 'none' };
      }
      const accept = await this.command('approve_plan_dialog', seatId, ['send-keys', '-t', paneId, '1']);
      if (accept.code !== 0) {
        return { before, after: before, changed: false, verified: false, mechanism: 'dialog_accept' };
      }
      // Acceptance needs BOTH witnesses: the dialog is gone AND the agent left
      // plan mode. A vanished dialog alone is equally consistent with a
      // dismissal that proceeded with nothing.
      const readBack = await observeDialog();
      const dismissed = readBack.code === 0 && !RealTmux.detectPlanDialog(readBack.stdout, engine);
      const after = await this.captureAgentMode(seatId, paneId, engine);
      const accepted = dismissed && after === 'work';
      return { before, after, changed: accepted, verified: accepted, mechanism: 'dialog_accept' };
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
  private seatEngines = new Map<string, SeatEngineLaunch>();
  private seatEngineStartFailures = new Set<string>();
  private tints = new Map<string, string>();
  private tintFailures = new Set<string>();
  private tintClearFailures = new Set<string>();
  private tintMisapplications = new Set<string>();
  private shape: { sessions: string[]; windows: Record<string, string[]> } = { sessions: [], windows: {} };
  private clipboard = new Uint8Array();
  private agentModes = new Map<string, AgentModeState>();
  private planDialogs = new Set<string>();
  private agentModeInputs = new Map<string, string[]>();
  private agentModeFailures = new Set<string>();
  private attachedClients = new Set<string>();
  private deliveredSelections: string[] = [];
  private wrapperPlacements = new Map<number, string>();

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
  setPlanDialog(seatId: string, posed: boolean): void {
    if (posed) this.planDialogs.add(seatId);
    else this.planDialogs.delete(seatId);
  }
  planDialog(seatId: string): boolean { return this.planDialogs.has(seatId); }
  async transitionAgentMode(
    seatId: string,
    engine: 'claude' | 'codex',
    intent: ModeTransitionIntent,
  ): Promise<AgentModeTransitionOutcome> {
    const before = this.agentModes.get(seatId) ?? 'unknown';
    if (intent === 'approve_plan') {
      if (engine !== 'claude' || !this.planDialogs.has(seatId)) {
        return { before, after: before, changed: false, verified: false, mechanism: 'none' };
      }
      this.agentModeInputs.set(seatId, [...(this.agentModeInputs.get(seatId) ?? []), '1']);
      if (this.agentModeFailures.has(seatId)) {
        return { before, after: before, changed: false, verified: false, mechanism: 'dialog_accept' };
      }
      this.planDialogs.delete(seatId);
      this.agentModes.set(seatId, 'work');
      return { before, after: 'work', changed: true, verified: true, mechanism: 'dialog_accept' };
    }
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
    // `respawn-pane -k` replaces the pane's process in place: a live process
    // is killed, a remain-on-exit corpse is revived. A missing pane is
    // repaired by splitting a surviving sibling, so it fails only when the
    // window has no pane left to anchor the split.
    const s = this.seats.get(seatId);
    if (!s) {
      const [page] = seatId.split(':', 1);
      const declared = page ? (TXD_WINDOWS[page as keyof typeof TXD_WINDOWS] as readonly string[] | undefined) : undefined;
      if (!declared?.includes(seatId)) return false;
      const anchors = declared.filter((seat) => this.seats.get(seat)?.pane === 'live');
      if (anchors.length === 0) return false;
      this.seats.set(seatId, { pane: 'live', generation: crypto.randomUUID() });
      const window = this.shape.windows[page!];
      if (window && !window.includes(seatId)) {
        this.shape.windows[page!] = declared.filter((seat) => window.includes(seat) || seat === seatId);
      }
      this.commands.delete(seatId);
      this.tints.delete(seatId);
      this.resets.push(seatId);
      return true;
    }
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
    for (const [seat] of this.seatEngines) if (seat.startsWith(`${page}:`)) this.seatEngines.delete(seat);
    for (const [seat] of this.tints) if (seat.startsWith(`${page}:`)) this.tints.delete(seat);
    for (const seat of seats) {
      this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
      this.commands.delete(seat);
    }
    this.pageRebuilds.push(page);
    return true;
  }
  async startSeatEngine(launch: SeatEngineLaunch): Promise<boolean> {
    if (this.seatEngineStartFailures.has(launch.seatId)) return false;
    const seat = this.seats.get(launch.seatId);
    if (!seat || seat.pane === 'dead') return false;
    this.seatEngines.set(launch.seatId, launch);
    this.commands.set(launch.seatId, launch.engine);
    return true;
  }
  failSeatEngineStart(seatId: string): void { this.seatEngineStartFailures.add(seatId); }
  seatEngine(seatId: string): SeatEngineLaunch | undefined {
    return this.seatEngines.get(seatId);
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
  bindWrapper(wrapperPid: number, seatId: string): void {
    this.wrapperPlacements.set(wrapperPid, seatId);
  }
  async attestWrapperPlacement(wrapperPid: number): Promise<WrapperPlacementAttestation> {
    const pane_id = this.wrapperPlacements.get(wrapperPid);
    if (!pane_id) return { ok: false, reason: 'wrapper_not_in_managed_pane' };
    const seat = this.seats.get(pane_id);
    if (!seat) return { ok: false, reason: 'wrapper_not_in_managed_pane' };
    if (seat.pane === 'dead') return { ok: false, reason: 'pane_dead' };
    return {
      ok: true,
      pane_id,
      pane_generation: seat.generation,
      wrapper_pid: wrapperPid,
      pane_root_pid: wrapperPid - 1,
      ancestry: [wrapperPid, wrapperPid - 1],
      process_start_ticks: {
        [String(wrapperPid)]: '200',
        [String(wrapperPid - 1)]: '100',
      },
    };
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
  private sentLines = new Map<string, string[]>();
  private paneTexts = new Map<string, string>();
  private redriveEnterCounts = new Map<string, number>();

  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return { bytes: 0, verdict: 'failed_none_delivered' };
    this.sentLines.set(seatId, [...(this.sentLines.get(seatId) ?? []), text]);
    return { bytes: Buffer.byteLength(text, 'utf8'), verdict: 'staged' };
  }
  async sendVerifiedToSeat(seatId: string, _correlationId: string, text: string, _tabAfterPrefix?: string) {
    const sent = await this.sendToSeat(seatId, text);
    return sent;
  }
  async observeComposerInteractive(seatId: string): Promise<boolean> {
    const s = this.seats.get(seatId);
    return !!s && s.pane === 'live'
      && RealTmux.composerInteractive(this.paneTexts.get(seatId) ?? '');
  }
  /** Test observation: every text staged into this seat, in order. */
  sends(seatId: string): string[] { return [...(this.sentLines.get(seatId) ?? [])]; }
  /** Test control: what the seat's visible pane currently shows. */
  setPaneText(seatId: string, text: string): void { this.paneTexts.set(seatId, text); }
  /** Test observation: how many redrive Enters this seat received. */
  redriveEnters(seatId: string): number { return this.redriveEnterCounts.get(seatId) ?? 0; }
  async redriveSeatComm(seatId: string, messageId: string, expectedFrame: string): Promise<CommRedriveDriveOutcome> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return 'seat_unresolved';
    const verdict = expectedFrame.includes(`tx comm ${messageId}`)
      ? RealTmux.composerVerdict(this.paneTexts.get(seatId) ?? '', messageId, expectedFrame)
      : RealTmux.inputVerdict(this.paneTexts.get(seatId) ?? '', expectedFrame);
    if (verdict === 'absent') return 'frame_absent';
    if (verdict === 'corrupted') return 'composer_corrupted';
    this.redriveEnterCounts.set(seatId, (this.redriveEnterCounts.get(seatId) ?? 0) + 1);
    return 'enter_redriven';
  }

  /**
   * Test control: which agents this fake observes as running. A seat absent
   * from the map has no live engine, so the default is DEAD — a test must say
   * an agent is alive, exactly as the real probe demands evidence.
   */
  liveAgents = new Map<string, string>();
  unobservableSeats = new Set<string>();
  /** Test control: this agent's engine is observably running. */
  markAgentAlive(seatId: string, agentId: string): void {
    this.liveAgents.set(seatId, agentId);
  }
  /**
   * Test control: this seat cannot be observed from here — an ssh transport
   * whose engine runs in a remote envelope, an unreadable /proc entry, an
   * unrecognised engine comm, or an agent mid-launch. The real probe reaches
   * this verdict on its own; the fake needs it stated because it models no
   * process tree.
   */
  markSeatUnobservable(seatId: string): void {
    this.unobservableSeats.add(seatId);
  }
  async agentLiveness(seatId: string, agentId: string): Promise<AgentLiveness> {
    if (!agentId) return 'unobservable';
    if (this.liveAgents.get(seatId) === agentId) return 'alive';
    if (this.unobservableSeats.has(seatId)) return 'unobservable';
    // Default DEAD on purpose: a test must ASSERT liveness to get protection,
    // so a guard regression shows up as a reaped fake rather than a quiet pass.
    return 'dead';
  }
}
