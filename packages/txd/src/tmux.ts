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

import {
  COUNCIL_GEOMETRY,
  councilGeometry,
  councilGeometryRows,
  isStackPage,
  seatBelongsToPage,
  TXD_ESTATE,
  TXD_SESSION,
  TXD_STACK_WINDOWS,
  TXD_WINDOWS,
  type TxdPage,
} from './estate.ts';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CLIPBOARD_BUFFER_NAME,
  MAX_CLIPBOARD_BYTES,
  MAX_RUN_CAPTURE_BYTES,
  type AgentModeState,
  type ModeTransitionIntent,
  type ModeTransitionMechanism,
} from '@terminus-os/contracts';
import {
  deliverClipboardToOrigin,
  type ClipboardMachineRegistry,
  type ClipboardOriginObservation,
  type ClipboardOriginOutcome,
} from './clipboard-origin.ts';

export type SeatObservation = { seat_id: string; pane: 'live' | 'dead' };
export type SeatReadinessObservation = SeatObservation & {
  tint: string | null | undefined;
  generation: string | undefined;
};
export type SeatWorkload = { seat_id: string; command: string; idle: boolean };
/**
 * One canonical page that fails the acceptance predicate while live tagged
 * panes still occupy it. `seats` names a live-seat set that is not the declared
 * one; `geometry` names a declared seat set in the wrong shape.
 */
export type PageDivergence = {
  page: TxdPage;
  clause: 'seats' | 'geometry';
  detail: string;
};
export type EstateEnsureResult = {
  state: 'created' | 'existing';
  rebuilt_pages: TxdPage[];
  diverged_pages: PageDivergence[];
};
export type EstateGeneration = 'empty' | 'canonical' | 'recoverable' | 'foreign';
export type LifecycleHookReadiness = {
  state: 'ready' | 'degraded';
  pane_died: boolean;
  pane_exited: boolean;
};
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
// handed this frame to a pane and pressed Enter; it cannot prove the engine
// consumed it, and it observes nothing else at send time — a capture raced
// against a busy engine's repaint proves nothing (specimen e5757301).
// A staged verdict is txd's transport-delivery witness and produces
// `act.comm_delivery_asserted`. Engine pickup is separately folded into
// `act.comm_observed` from UserPromptSubmit or the WORKING-engine stop join.
export type SendOutcome = { verdict: 'staged'; bytes: number };

/**
 * The composer-at-rest observation the stop join reads. `frame_absent` — a
 * VISIBLE composer no longer holds the exact frame, so the frame left it into
 * the engine. `frame_present` — the frame still sits un-submitted (an
 * interrupted turn keeps its queue painted). `unobservable` — no visible
 * composer, no capture, or no pane: absence of evidence, never absence.
 */
export type FrameRestObservation = 'frame_absent' | 'frame_present' | 'unobservable';

/**
 * The lost-Enter completion outcome. `submit_completed` — the exact staged
 * frame was observed intact in the at-rest composer and one Enter was driven;
 * `submit_failed` — the frame was intact but the Enter keypress could not be
 * handed to the pane. Everything else is a zero-effect refusal: the evidence
 * for driving anything was absent.
 */
export type StagedSubmitCompletion =
  | 'submit_completed'
  | 'submit_failed'
  | 'frame_absent'
  | 'unobservable'
  | 'seat_unresolved';

export type ComposerVerdict = 'intact' | 'corrupted' | 'absent';
export type ComposerRefusal =
  | 'submit_failed'
  | 'transport_failed'
  | 'seat_unresolved';

const ANSI_CSI = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
const stripAnsi = (text: string): string => text.replace(ANSI_CSI, '');

export type AgentModeTransitionOutcome = {
  before: AgentModeState;
  after: AgentModeState;
  changed: boolean;
  verified: boolean;
  mechanism: ModeTransitionMechanism;
};

// A pane-shell run's harvest. Streams are captured to files the command's own
// redirections write, so stdout and stderr come back separated and byte-exact
// (lossily decoded to UTF-8 for the JSON surface); the exit code is the
// command's real one, read after the completion signal.
export type ShellRunOutcome = {
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

// Staging is split from completion so the caller can refuse loudly and fast
// (unresolvable seat, busy pane, failed stage) before anything defers, then
// await the completion promise for as long as the command actually runs.
export type ShellRunStaged = { completion: Promise<ShellRunOutcome> };

export interface TmuxControlPlane {
  reachable(): Promise<boolean>;
  /** Install the daemon's tmux lifecycle witnesses and verify their physical read-back. */
  ensureLifecycleHooks(): Promise<void>;
  /** Observe the currently installed witnesses; procedure completion is not health evidence. */
  lifecycleHookReadiness(): Promise<LifecycleHookReadiness>;
  version(): Promise<string | null>;
  workloads(): Promise<SeatWorkload[]>;
  killServer(): Promise<boolean>;
  /** Live seats as canonical ids + pane liveness. Never exposes %id. */
  listSeats(): Promise<SeatObservation[]>;
  /** One physical snapshot for estate tint/generation readiness. */
  seatReadiness(): Promise<SeatReadinessObservation[]>;
  /**
   * Create the declared estate on an empty socket, or accept an existing one:
   * a page with no live tagged pane is reconstructed; a page that still holds
   * live panes is never rebuilt here, only reported in `diverged_pages`.
   */
  ensureEstate(): Promise<EstateEnsureResult>;
  /** Every canonical page failing the acceptance predicate, with the clause it fails. */
  estateDivergences(): Promise<PageDivergence[]>;
  /** Classify the observed estate; an unrecognized topology is foreign, never repaired blind. */
  estateGeneration(): Promise<EstateGeneration>;
  /** Create a bare seat: a single-pane session tagged with the canonical id. */
  createSeat(seatId: string): Promise<void>;
  /** Split one dynamic pane into a mitosis page and tile the page once. */
  createStackSeat(page: string, seatId: string): Promise<void>;
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
  sendVerifiedToSeat(seatId: string, correlationId: string, text: string, tabAfterPrefix?: string, engine?: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }>;
  /**
   * Stage one shell command in an AGENT pane through the engine's own shell
   * escape: Claude's bash mode is entered by a literal `!` KEYSTROKE on an
   * empty composer (a bracketed paste of `!` stays text and would submit a
   * prompt instead of running anything), then the command is pasted and
   * verified; Codex parses a literal `!`-prefixed composer line at submit, so
   * the whole `!<command>` line rides the verified send path.
   */
  runInAgentComposer(seatId: string, runId: string, command: string, engine: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }>;
  /**
   * Execute one shell command in a BARE pane's idle shell and harvest its
   * stdout/stderr/exit code. Refuses loud and typed before staging:
   * `seat_unresolved` (no such pane), `pane_busy: <command>` (a foreground
   * workload owns the pane), `stage_failed`. Completion is event-driven — the
   * staged line signals a per-run `tmux wait-for` channel when the command
   * exits — no polling loop, no deadline; aborting `signal` (the pane died
   * mid-run) rejects the completion with `pane_lost_mid_run`.
   */
  runInShellPane(seatId: string, runId: string, command: string, signal: AbortSignal): Promise<ShellRunStaged>;
  /** Observe whether the live engine exposes an interactive prompt. */
  observeComposerInteractive(seatId: string): Promise<boolean>;
  /**
   * Observe, at a caller-held at-rest event (the target's stop), whether the
   * exact frame still sits in the visible composer. Evidence for the turn-stop
   * observation join; `unobservable` is absence of evidence, never absence.
   */
  observeFrameAbsence(seatId: string, expectedFrame: string): Promise<FrameRestObservation>;
  /**
   * Complete one staged submit whose Enter had no engine effect (live specimen
   * 29fb6cc0): in ONE serialized pane transaction, observe the at-rest
   * composer, and only when it holds the EXACT staged frame drive one Enter
   * for the same transaction. Every other observation refuses with zero
   * effect. An already asserted transport never reaches this recovery path.
   */
  completeStagedSubmit(seatId: string, expectedFrame: string, expectedPaneGeneration?: string): Promise<StagedSubmitCompletion>;
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
  /** Commit one selection to the transient buffer and its transport-bound origin. */
  commitClipboardSelection(text: string, clientTty: string): Promise<ClipboardOriginOutcome>;
}

// The declared split placing each seat, mirrored from constructPage's
// construction graph: the sibling whose edge the seat shares, the split
// orientation, and the declared share where the default even split would not
// restore it (the full-height flank columns hold 30% of the window by
// construction). repairSeat re-runs exactly this split to put a killed seat
// back without touching any survivor.
const REPAIR_SPLITS: Record<string, { source: string; flags: string[]; size?: string }> = {
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

export type TmuxCommandResult = { code: number; stdout: string; stderr: string };
type TmuxRunner = (socket: string, args: string[], stdin?: Uint8Array) => Promise<TmuxCommandResult>;
type TmuxBinaryResult = { code: number; stdout: Uint8Array; stderr: string; overflow?: boolean };
type TmuxBinaryRunner = (socket: string, args: string[]) => Promise<TmuxBinaryResult>;
type WriteClient = (path: string, data: Uint8Array) => Promise<void>;
type ObserveClipboardOrigin = (clientTty: string) => Promise<ClipboardOriginObservation>;

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
  // The control client is infrastructure, never an agent. Do not let the
  // daemon's invoking shell donate its identity to tmux's global/session
  // environment; bind is the only path that may add AGENT_ID, explicitly via
  // respawn-pane -e below.
  const environment = { ...process.env };
  delete environment[AGENT_ID_ENV];
  delete environment.TMUX;
  return Bun.spawn(['tmux', '-L', socket, ...args], { ...options, env: environment });
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

type WaitForSignal = (socket: string, channel: string, signal: AbortSignal) => Promise<void>;

// The pane run's completion event: one client blocked on `tmux wait-for`
// wakes exactly when the staged line signals the channel after the command
// exits. Nothing here observes state repeatedly — the tmux server holds the
// client until the signal — and the only exits are the signal itself, the
// caller's abort (the pane died mid-run), or the tmux server dying. All loud.
async function waitForSignal(socket: string, channel: string, signal: AbortSignal): Promise<void> {
  const proc = spawnTmuxProcess(socket, ['wait-for', channel], { stdout: 'pipe', stderr: 'pipe' });
  const abort = () => proc.kill();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const code = await proc.exited;
  signal.removeEventListener('abort', abort);
  if (signal.aborted) throw new Error('pane_lost_mid_run');
  if (code !== 0) throw new Error('run_wait_failed');
}

// Read one captured stream file up to the contract ceiling; a byte past it is
// reported as truncation, never silently dropped bytes plus a clean flag.
async function readCapturedStream(path: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return { text: '', truncated: false };
  try {
    const buffer = Buffer.alloc(MAX_RUN_CAPTURE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > MAX_RUN_CAPTURE_BYTES;
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_RUN_CAPTURE_BYTES));
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated };
  } finally {
    await handle.close();
  }
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
  private observeClipboardOrigin: ObserveClipboardOrigin;
  private machineRegistry: ClipboardMachineRegistry;
  private machine: string | undefined;
  private waitFor: WaitForSignal;
  private paneInputQueues = new Map<string, Promise<unknown>>();

  constructor(
    private socket: string,
    options: {
      run?: TmuxRunner;
      runBytes?: TmuxBinaryRunner;
      writeClient?: WriteClient;
      observeClipboardOrigin?: ObserveClipboardOrigin;
      machineRegistry?: ClipboardMachineRegistry;
      audit?: AuditSink;
      machine?: string;
      waitForSignal?: WaitForSignal;
    } = {},
  ) {
    this.runner = options.run ?? run;
    this.binaryRunner = options.runBytes ?? runBytes;
    this.audit = options.audit ?? ((record) => console.info(JSON.stringify({ level: 'info', event: 'tmux_operation', ...record })));
    this.writeClient = options.writeClient ?? (async (target, data) => {
      // tmux skips tty_set_selection for empty buffers. Refuse instead of
      // claiming a clear that never reached the bound origin (or broadcasting
      // a raw escape through a shared pane to every attached client).
      if (data.byteLength === 0) throw new Error('clipboard origin transport refused');
      const loaded = await this.command(
        'clipboard_origin_transfer',
        'origin-client',
        ['load-buffer', '-w', '-b', CLIPBOARD_BUFFER_NAME, '-t', target, '-'],
        data,
      );
      if (loaded.code !== 0) throw new Error('clipboard origin transport refused');
      // The transfer effect already succeeded. Keep explicit clipboard push
      // coherent for an empty selection without letting bookkeeping rewrite
      // the observed delivery outcome.
      await this.command(
        'clipboard_origin_marker',
        CLIPBOARD_BUFFER_NAME,
        ['set-option', '-g', '@tx_clipboard_empty', data.byteLength === 0 ? '1' : '0'],
      );
    });
    this.machineRegistry = options.machineRegistry ?? { machines: {} };
    this.observeClipboardOrigin = options.observeClipboardOrigin
      ?? ((clientTty) => this.readClipboardOrigin(clientTty));
    this.machine = options.machine;
    this.waitFor = options.waitForSignal ?? waitForSignal;
  }

  private paneEnvironment(seatId: string, agentId?: string): string[] {
    // Pane-local environment is the inheritance boundary for every process and
    // every fresh shell in this workspace. Bind adds identity explicitly;
    // server/session defaults and teardown keep bare panes clear below.
    const environment = ['-e', `${PANE_ID_ENV}=${seatId}`];
    if (agentId !== undefined) environment.push('-e', `${AGENT_ID_ENV}=${agentId}`);
    if (this.machine) environment.push('-e', `${MACHINE_ENV}=${this.machine}`);
    return environment;
  }

  /** Keep tmux's inherited defaults from supplying an identity to bare panes. */
  private async clearDefaultAgentEnvironment(target?: string): Promise<boolean> {
    const args = target
      ? ['set-environment', '-u', '-t', target, AGENT_ID_ENV]
      : ['set-environment', '-g', '-u', AGENT_ID_ENV];
    return (await this.command(
      'clear_agent_environment',
      target ?? 'server',
      args,
    )).code === 0;
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
   * Serialize one complete composer transaction per pane. The in-process queue
   * preserves call order. The predecessor's completion is the event that
   * releases the next waiter; there is no retry loop or timeout layered over a
   * hung input operation.
   */
  private serializePaneInput<T>(seatId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.paneInputQueues.get(seatId) ?? Promise.resolve();
    const run = predecessor.then(operation);
    const settled = run.then(() => undefined, () => undefined);
    this.paneInputQueues.set(seatId, settled);
    settled.finally(() => {
      if (this.paneInputQueues.get(seatId) === settled) this.paneInputQueues.delete(seatId);
    });
    return run;
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

  private async readClipboardOrigin(clientTty: string): Promise<ClipboardOriginObservation> {
    const clients = await this.command(
      'observe_clipboard_clients',
      'invoking-client',
      ['list-clients', '-F', '#{client_tty}\t#{client_pid}'],
    );
    if (clients.code !== 0) {
      return { requested_tty: clientTty, attached_clients: [], process_ancestors: {} };
    }
    const attached_clients = clients.stdout.split('\n').filter(Boolean).flatMap((line) => {
      const [tty, rawPid] = line.split('\t');
      const process_id = Number(rawPid);
      return tty && Number.isInteger(process_id) && process_id > 1 ? [{ tty, process_id }] : [];
    });
    const process_ancestors: ClipboardOriginObservation['process_ancestors'] = {};
    for (const client of attached_clients) {
      let processId = client.process_id;
      const visited = new Set<number>();
      while (processId > 1 && !visited.has(processId)) {
        visited.add(processId);
        try {
          const [witness, command] = await Promise.all([
            processWitness(processId),
            readFile(`/proc/${processId}/cmdline`),
          ]);
          if (!witness || witness.parent_pid < 1) break;
          process_ancestors[processId] = {
            parent_process_id: witness.parent_pid,
            command: command.toString('utf8').replaceAll('\0', ' ').trim(),
          };
          processId = witness.parent_pid;
        } catch {
          break;
        }
      }
    }
    return { requested_tty: clientTty, attached_clients, process_ancestors };
  }

  async commitClipboardSelection(text: string, clientTty: string): Promise<ClipboardOriginOutcome> {
    const bytes = new TextEncoder().encode(text);
    const observation = await this.observeClipboardOrigin(clientTty);
    const result = await deliverClipboardToOrigin(
      bytes,
      observation,
      this.machineRegistry,
      this.writeClient,
      (entry) => this.audit({
        operation: entry.operation,
        target: entry.origin ?? 'unresolved-origin',
        outcome: entry.outcome === 'delivered' ? 'succeeded' : 'failed',
        duration_ms: 0,
        stderr_category: entry.outcome === 'delivered' ? 'none' : 'transport_error',
      }),
    );
    await this.command(
      'report_clipboard_selection',
      'invoking-client',
      ['display-message', '-c', clientTty, `clipboard ${result.outcome} (${bytes.byteLength} bytes)`],
    );
    return result;
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

  async seatReadiness(): Promise<SeatReadinessObservation[]> {
    const observed = await this.command('observe_seat_readiness', 'estate', [
      'list-panes', '-a', '-F',
      `#{${CANON_OPT}}\t#{pane_dead}\t#{window-style}\t#{window-active-style}\t#{${GENERATION_OPT}}`,
    ]);
    if (observed.code !== 0) return [];
    return observed.stdout.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      const [seat_id, dead, inactive = '', active = '', generation = ''] = line.split('\t');
      if (!seat_id) return [];
      const styles = [inactive, active] as const;
      const tint = styles.every((style) => style === '' || style === 'default')
        ? null
        : styles[0] === styles[1] && styles[0].startsWith('bg=')
          ? styles[0].slice(3)
          : styles.join('|');
      return [{
        seat_id,
        pane: dead === '1' ? 'dead' as const : 'live' as const,
        tint,
        generation: generation || undefined,
      }];
    });
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

  private async councilRows(target: string): Promise<{ top: number; bottom: number }> {
    const raw = await this.checked(
      ['display-message', '-p', '-t', target, '#{window_height}'],
      'observe council window height',
      'council',
    );
    const height = Number(raw);
    if (!Number.isInteger(height) || height < 2) {
      throw new Error(`txd tmux council window has invalid height: ${raw}`);
    }
    return councilGeometryRows(height);
  }

  private async declareCouncilGeometry(target: string): Promise<void> {
    const options = {
      '@txd_council_minimum_usable_columns': String(COUNCIL_GEOMETRY.pane.minimumUsableColumns),
      '@txd_council_top_numerator': String(COUNCIL_GEOMETRY.top.numerator),
      '@txd_council_top_denominator': String(COUNCIL_GEOMETRY.top.denominator),
      '@txd_council_horizontal_borders': String(COUNCIL_GEOMETRY.horizontalBorders),
      '@txd_council_vertical_borders': String(COUNCIL_GEOMETRY.verticalBorders),
    } as const;
    for (const [name, value] of Object.entries(options)) {
      await this.checked(['set-option', '-w', '-t', target, name, value], 'declare council geometry', 'council');
    }
  }

  private static layoutChecksum(layout: string): string {
    let checksum = 0;
    for (const character of layout) {
      checksum = ((checksum >>> 1) + ((checksum & 1) << 15) + character.charCodeAt(0)) & 0xffff;
    }
    return checksum.toString(16).padStart(4, '0');
  }

  private static councilLayout(
    windowWidth: number,
    windowHeight: number,
    panes: readonly [string, string, string, string],
  ): string {
    const desired = councilGeometry(windowWidth, windowHeight);
    const leaf = (index: number): string => {
      const pane = panes[index]!;
      const geometry = desired.panes[index]!;
      return `${geometry.width}x${geometry.height},${geometry.left},${geometry.top},${pane.replace(/^%/, '')}`;
    };
    const body = desired.shape === 'columns'
      ? `${windowWidth}x${windowHeight},0,0{`
        + `${desired.panes[0].width}x${windowHeight},0,0[${leaf(0)},${leaf(1)}],`
        + `${desired.panes[2].width}x${windowHeight},${desired.panes[2].left},0[${leaf(2)},${leaf(3)}]}`
      : `${windowWidth}x${windowHeight},0,0[${leaf(0)},${leaf(1)},${leaf(2)},${leaf(3)}]`;
    return `${RealTmux.layoutChecksum(body)},${body}`;
  }

  private async applyCouncilGeometry(target: string): Promise<void> {
    const dimensions = await this.checked(
      ['display-message', '-p', '-t', target, '#{window_width}\t#{window_height}'],
      'observe council window dimensions',
      'council',
    );
    const [rawWidth = '', rawHeight = ''] = dimensions.split('\t');
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 7) {
      throw new Error(`txd tmux council window has invalid dimensions: ${dimensions}`);
    }
    const resolved = await Promise.all(TXD_WINDOWS.council.map((seat) => this.resolvePane(seat)));
    if (resolved.some((pane) => pane === null)) throw new Error('txd cannot apply Council geometry with a missing seat');
    const panes = resolved as unknown as [string, string, string, string];
    await this.checked(
      ['select-layout', '-t', target, RealTmux.councilLayout(width, height, panes)],
      'apply council geometry',
      'council',
    );
    await this.checked(
      ['set-option', '-w', '-t', target, '@txd_council_geometry_dimensions', `${width}x${height}`],
      'record council geometry dimensions',
      'council',
    );
  }

  /**
   * Pane geometry as the window lays it out.
   *
   * `pane_left` and its siblings report the *visible* projection, so a zoomed
   * pane answers with the whole window while the panes beside it keep their
   * real coordinates — a page read through a zoom looks exactly like a page
   * whose panes have drifted apart. `window_layout` is the layout itself and a
   * zoom never touches it; `window_visible_layout` is where the zoom lands.
   * The estate is observed through the layout so that an operator zooming a
   * pane to read it cannot be mistaken for the estate coming apart.
   *
   * A leaf in a layout is `WxH,x,y,<pane id>`; a container is the same shape
   * followed by `{` or `[`. The trailing pane id is what separates the two,
   * and neither brace can appear inside a match, so the leaves are exactly the
   * five-number runs.
   */
  private static layoutGeometry(layout: string): Map<string, Omit<EstateRow, 'session' | 'window' | 'seat'>> {
    const panes = new Map<string, Omit<EstateRow, 'session' | 'window' | 'seat'>>();
    const [, windowWidth = '', windowHeight = ''] = layout.match(/^[^,]*,(\d+)x(\d+),/) ?? [];
    for (const [, width, height, left, top, pane] of layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)) {
      panes.set(`%${pane}`, {
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        windowWidth: Number(windowWidth),
        windowHeight: Number(windowHeight),
      });
    }
    return panes;
  }

  private async estateRows(): Promise<EstateRow[]> {
    const result = await this.command('observe_estate', 'estate', [
      'list-panes', '-a', '-F',
      `#{session_name}\t#{window_name}\t#{${CANON_OPT}}\t#{pane_id}\t#{window_layout}`,
    ]);
    if (result.code !== 0) return [];
    const layouts = new Map<string, Map<string, Omit<EstateRow, 'session' | 'window' | 'seat'>>>();
    return result.stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
      const [session = '', window = '', seat = '', pane = '', layout = ''] = line.split('\t');
      if (seat.length === 0) return [];
      let geometry = layouts.get(layout);
      if (!geometry) {
        geometry = RealTmux.layoutGeometry(layout);
        layouts.set(layout, geometry);
      }
      // A pane its own window's layout does not carry is a pane whose geometry
      // cannot be observed. Dropping it reads as a missing seat, which is the
      // divergence it is — never a seat quietly accepted unmeasured.
      const placement = geometry.get(pane);
      return placement ? [{ session, window, seat, ...placement }] : [];
    });
  }

  private pageGeometryMatches(window: string, seats: readonly string[], rows: EstateRow[]): boolean {
    const panes = rows.filter((row) => row.session === TXD_SESSION && row.window === window);
    if (panes.length !== seats.length) return false;
    const bySeat = new Map(panes.map((row) => [row.seat, row]));
    if (seats.some((seat) => !bySeat.has(seat))) return false;

    if (window === 'council' && seats.length === 4) {
      const first = bySeat.get(seats[0]!)!;
      const desired = councilGeometry(first.windowWidth, first.windowHeight);
      return seats.every((seat, index) => {
        const observed = bySeat.get(seat)!;
        const expected = desired.panes[index]!;
        return observed.left === expected.left
          && observed.top === expected.top
          && observed.width === expected.width
          && observed.height === expected.height
          && observed.windowWidth === first.windowWidth
          && observed.windowHeight === first.windowHeight;
      });
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

  /** Reproject a structurally intact Council after tmux changes window rows. */
  private async reflowCouncil(rows: EstateRow[]): Promise<void> {
    const seats = TXD_WINDOWS.council;
    const panes = rows.filter((row) => row.session === TXD_SESSION && row.window === 'council');
    if (panes.length !== seats.length) return;
    const bySeat = new Map(panes.map((row) => [row.seat, row]));
    if (seats.some((seat) => !bySeat.has(seat))) return;
    const nw = bySeat.get(seats[0]!)!;
    const sw = bySeat.get(seats[1]!)!;
    const ne = bySeat.get(seats[2]!)!;
    const se = bySeat.get(seats[3]!)!;
    const originTop = Math.min(...panes.map((pane) => pane.top));
    const columns = nw.left === 0 && nw.top === originTop
      && sw.left === 0 && sw.top === nw.top + nw.height + 1
      && ne.left === nw.width + 1 && ne.top === originTop
      && se.left === ne.left && se.top === ne.top + ne.height + 1
      && nw.width === sw.width && ne.width === se.width
      && nw.height === ne.height && sw.height === se.height
      && ne.left + ne.width === nw.windowWidth
      && sw.top + sw.height === nw.windowHeight
      && se.top + se.height === nw.windowHeight;
    const stack = [nw, sw, ne, se].every((pane, index, ordered) =>
      pane.left === 0
      && pane.width === pane.windowWidth
      && pane.top === (index === 0 ? originTop : ordered[index - 1]!.top + ordered[index - 1]!.height + 1),
    ) && se.top + se.height === nw.windowHeight;
    if (!columns && !stack) return;
    if (this.pageGeometryMatches('council', seats, rows)) return;
    await this.applyCouncilGeometry(`${TXD_SESSION}:=council`);
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
    const missing = expected.filter((row) => !actual.includes(row));
    const duplicates = [...new Set(actual.filter((row, index) => actual.indexOf(row) !== index))];
    const unexpected = rows
      .filter((row) => row.session !== TXD_SESSION || !seatBelongsToPage(row.window, row.seat))
      .map((row) => `${row.session}\t${row.window}\t${row.seat}`)
      .sort();
    if (missing.length > 0 || unexpected.length > 0 || duplicates.length > 0) {
      const render = (list: string[]): string =>
        list.length === 0 ? 'none' : list.map((row) => row.split('\t').join(':')).join(', ');
      return 'estate seats diverged'
        + ` (missing: ${render(missing)}; unexpected: ${render(unexpected)}; duplicates: ${render(duplicates)};`
        + ` observed ${actual.length} panes with ${expected.length} required)`;
    }
    for (const [window, seats] of Object.entries(TXD_WINDOWS)) {
      if (isStackPage(window)) continue;
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
    const recoverable = rows.every((row) => {
      return row.session === TXD_SESSION && (row.seat === '' || seatBelongsToPage(row.window, row.seat));
    });
    return recoverable ? 'recoverable' : 'foreign';
  }

  private lifecycleHookCommands() {
    // Every hook capture goes to the txd-tmux-hook journal identifier, which is
    // the sole surface `tx inspect hooks` reads. A hook that skips systemd-cat
    // fires invisibly to the diagnostic, so the tail is identical to the one
    // tx.conf's kill hooks carry.
    return {
      'pane-died': 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-died --page #{q:window_name} 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"',
      'pane-exited': 'run-shell -b "$HOME/.bun/bin/bun $HOME/.local/bin/tx estate event pane-exited --page #{q:window_name} 2>&1 | systemd-cat --identifier=txd-tmux-hook || true"',
    } as const;
  }

  async lifecycleHookReadiness(): Promise<LifecycleHookReadiness> {
    const observed = await Promise.all(Object.keys(this.lifecycleHookCommands()).map(async (hook) => {
      const result = await this.command('observe_lifecycle_hook', hook, ['show-hooks', '-g', hook]);
      // tmux expands $HOME while storing the hook, so read-back cannot be a
      // byte comparison with the submitted command. Pin every semantic part
      // that makes this the daemon's witness rather than an arbitrary hook.
      return result.code === 0
        && result.stdout.includes(`${hook}[`)
        && result.stdout.includes(`tx estate event ${hook} --page #{q:window_name}`);
    }));
    const [pane_died = false, pane_exited = false] = observed;
    return {
      state: pane_died && pane_exited ? 'ready' : 'degraded',
      pane_died,
      pane_exited,
    };
  }

  async ensureLifecycleHooks(): Promise<void> {
    for (const [hook, command] of Object.entries(this.lifecycleHookCommands())) {
      await this.checked(['set-hook', '-g', hook, command], `install ${hook} lifecycle witness`);
    }
    const readiness = await this.lifecycleHookReadiness();
    if (readiness.state !== 'ready') {
      throw new Error('txd could not attest its lifecycle witnesses');
    }
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
    if (isStackPage(page)) {
      panes = [first];
    } else if (page === 'palace') {
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
      await this.declareCouncilGeometry(first);
      const councilRows = await this.councilRows(first);
      const northeast = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[2]!), '-c', this.homeDirectory(), '-l', '50%', '-t', first],
        'split council east column',
        page,
      );
      const southwest = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[1]!), '-c', this.homeDirectory(), '-l', String(councilRows.bottom), '-t', first],
        'split council southwest',
        page,
      );
      const southeast = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(seats[3]!), '-c', this.homeDirectory(), '-l', String(councilRows.bottom), '-t', northeast],
        'split council southeast',
        page,
      );
      panes = [first, southwest, northeast, southeast];
    } else {
      throw new Error(`txd refused unknown page ${page}`);
    }
    await Promise.all(seats.map((seat, index) => this.tag(panes[index]!, seat)));
    if (page === 'council') await this.applyCouncilGeometry(`${TXD_SESSION}:=council`);
    return panes;
  }

  /**
   * Drop a page's zoom as part of reconstructing it.
   *
   * Zoom is the operator's, and txd does not get to take it back to tidy the
   * estate: a page whose every pane is the right process in the right place is
   * canonical whether or not somebody is reading one of them full-window. The
   * only callers are the paths that are already replacing the page's panes,
   * where there is no zoom left to preserve.
   */
  private async clearPageZoom(page: string, target: string): Promise<boolean> {
    const zoomed = await this.command('observe_page_zoom', page, ['display-message', '-p', '-t', target, '#{window_zoomed_flag}']);
    if (zoomed.code !== 0) return false;
    if (zoomed.stdout.trim() !== '1') return true;
    return (await this.command('clear_page_zoom', page, ['resize-pane', '-Z', '-t', target])).code === 0;
  }

  /** The canonical acceptance predicate for one page: live seats and geometry. */
  private async pageIsCanonical(page: string, expected: readonly string[]): Promise<boolean> {
    const observed = (await this.listSeats()).filter((seat) => seat.seat_id.split(':', 1)[0] === page);
    const live = observed.filter((seat) => seat.pane === 'live').map((seat) => seat.seat_id).sort();
    if (isStackPage(page)) {
      return expected.every((seat) => observed.filter((row) => row.seat_id === seat).length === 1
          && observed.find((row) => row.seat_id === seat)?.pane === 'live')
        && observed.every((seat) => seat.pane === 'live' && seatBelongsToPage(page, seat.seat_id));
    }
    const want = [...expected].sort();
    if (live.length !== want.length || !live.every((seat, index) => seat === want[index])) return false;
    return this.pageGeometryMatches(page, expected, await this.estateRows());
  }

  /** The acceptance predicate for one page, stated as the clause it fails. */
  private async pageDivergence(page: TxdPage, expected: readonly string[]): Promise<PageDivergence | null> {
    if (await this.pageIsCanonical(page, expected)) return null;
    const observed = (await this.listSeats()).filter((seat) => seatBelongsToPage(page, seat.seat_id));
    const live = observed.filter((seat) => seat.pane === 'live').map((seat) => seat.seat_id);
    const dead = observed.filter((seat) => seat.pane === 'dead').map((seat) => seat.seat_id);
    const missing = expected.filter((seat) => !observed.some((row) => row.seat_id === seat));
    const unexpected = live.filter((seat) => !expected.includes(seat));
    const duplicates = [...new Set(live.filter((seat, index) => live.indexOf(seat) !== index))];
    const seatsDiverged = isStackPage(page)
      ? missing.length > 0 || dead.length > 0 || duplicates.length > 0
      : missing.length > 0 || dead.length > 0 || unexpected.length > 0 || duplicates.length > 0;
    const render = (list: string[]): string => (list.length === 0 ? 'none' : list.join(', '));
    if (seatsDiverged) {
      return {
        page,
        clause: 'seats',
        detail: `missing: ${render(missing)}; dead: ${render(dead)}; unexpected: ${render(unexpected)}; duplicates: ${render(duplicates)}`,
      };
    }
    return { page, clause: 'geometry', detail: this.describePage(page, await this.estateRows()) };
  }

  async estateDivergences(): Promise<PageDivergence[]> {
    const divergences: PageDivergence[] = [];
    for (const [page, expected] of Object.entries(TXD_WINDOWS)) {
      const divergence = await this.pageDivergence(page as TxdPage, expected);
      if (divergence) divergences.push(divergence);
    }
    return divergences;
  }

  /**
   * Accept one existing canonical page without closing a live pane. A flexible
   * page's missing or dead allocation pane is repaired around its workers. A
   * page with no live tagged pane left has nobody on it for a rebuild to
   * sacrifice, so that class alone is reconstructed. Every other divergence is
   * returned, never repaired: repair of an occupied page is an explicit
   * operator verb, not a boot side effect.
   */
  private async acceptPage(
    page: TxdPage,
    expected: readonly string[],
  ): Promise<{ divergence: PageDivergence | null; rebuilt: boolean }> {
    if (await this.pageIsCanonical(page, expected)) return { divergence: null, rebuilt: false };
    const observed = (await this.listSeats()).filter((seat) => seatBelongsToPage(page, seat.seat_id));
    if (isStackPage(page)) {
      const allocation = observed.filter((seat) => seat.seat_id === TXD_STACK_WINDOWS[page]);
      if (allocation.length === 1 && allocation[0]!.pane === 'dead') {
        if (!(await this.resetSeat(TXD_STACK_WINDOWS[page]))) {
          throw new Error(`txd could not repair the ${page} allocation pane: ${this.describePage(page, await this.estateRows())}`);
        }
        return { divergence: await this.pageDivergence(page, expected), rebuilt: false };
      }
      if (allocation.length === 0 && observed.some((seat) => seat.pane === 'live')) {
        await this.createStackSeat(page, TXD_STACK_WINDOWS[page]);
        return { divergence: await this.pageDivergence(page, expected), rebuilt: false };
      }
    }
    if (observed.some((seat) => seat.pane === 'live')) {
      return { divergence: await this.pageDivergence(page, expected), rebuilt: false };
    }
    if (!(await this.rebuildPage(page))) {
      throw new Error(
        `txd could not drive canonical page ${page} to canonical shape: ${this.describePage(page, await this.estateRows())}`,
      );
    }
    const divergence = await this.pageDivergence(page, expected);
    if (divergence) {
      throw new Error(`txd could not drive canonical page ${page} to canonical shape: ${divergence.detail}`);
    }
    return { divergence: null, rebuilt: true };
  }

  async rebuildPage(page: string): Promise<boolean> {
    if (!Object.hasOwn(TXD_WINDOWS, page)) return false;
    if (isStackPage(page)) {
      const live = (await this.listSeats()).filter((seat) =>
        seat.pane === 'live' && seatBelongsToPage(page, seat.seat_id),
      );
      if (live.length > 0) return true;
    }
    const target = `${TXD_SESSION}:=${page}`;
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
    if (!(await this.clearDefaultAgentEnvironment())) {
      throw new Error('txd could not clear the tmux server agent environment');
    }
    await this.ensureLifecycleHooks();
    const rows = await this.estateRows();
    if (rows.length > 0) {
      const recoverable = rows.every((row) => {
        return row.session === TXD_SESSION && (row.seat === '' || seatBelongsToPage(row.window, row.seat));
      });
      if (!recoverable) throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
      if (rows.some((row) => row.session === TXD_SESSION && row.window === 'council')) {
        await this.declareCouncilGeometry(`${TXD_SESSION}:=council`);
        await this.reflowCouncil(rows);
      }
      if (!(await this.clearDefaultAgentEnvironment(TXD_SESSION))) {
        throw new Error('txd could not clear the estate session agent environment');
      }
      // Acceptance is observation, not enforcement. Each page is read against
      // the same predicate that later accepts it; a page still holding live
      // panes that fails it is reported, and only a page nobody occupies is
      // reconstructed. The one estate-wide postcondition is that every page
      // was either accepted, rebuilt to acceptance, or named as diverged.
      const rebuilt_pages: TxdPage[] = [];
      const diverged_pages: PageDivergence[] = [];
      for (const [page, expectedSeats] of Object.entries(TXD_WINDOWS)) {
        const accepted = await this.acceptPage(page as TxdPage, expectedSeats);
        if (accepted.rebuilt) rebuilt_pages.push(page as TxdPage);
        if (accepted.divergence) diverged_pages.push(accepted.divergence);
      }
      if (diverged_pages.length === 0) {
        const divergence = this.canonicalDivergence(await this.estateRows());
        if (divergence) throw new Error(`txd canonical estate recovery could not converge: ${divergence}`);
      }
      const seats = (await this.listSeats()).filter((seat) => seat.pane === 'live').map((seat) => seat.seat_id);
      for (const seat of seats) {
        try {
          await this.ensureSeatGeneration(seat);
        } catch {
          const page = seat.split(':', 1)[0]!;
          throw new Error(
            `txd could not drive canonical page ${page} to canonical shape: ${this.describePage(page, await this.estateRows())}`,
          );
        }
      }
      return { state: 'existing', rebuilt_pages, diverged_pages };
    }

    let sessionCreated = false;
    try {
      const mechanicus = await this.estateChecked(
        ['new-session', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(TXD_STACK_WINDOWS.mechanicus), '-c', this.homeDirectory(), '-s', TXD_SESSION, '-n', 'mechanicus', '-x', '200', '-y', '60'],
        'create canonical session',
      );
      sessionCreated = true;
      await this.tag(mechanicus, TXD_STACK_WINDOWS.mechanicus);

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
      await this.declareCouncilGeometry(council);
      const councilRows = await this.councilRows(council);
      const councilNE = await this.estateChecked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:pax'), '-c', this.homeDirectory(), '-l', '50%', '-t', council],
        'split council east column',
      );
      const councilSW = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:fabricator-general'), '-c', this.homeDirectory(), '-l', String(councilRows.bottom), '-t', council],
        'split council southwest',
      );
      const councilSE = await this.estateChecked(
        ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment('council:orchestrator'), '-c', this.homeDirectory(), '-l', String(councilRows.bottom), '-t', councilNE],
        'split council southeast',
      );
      const councilPanes = [council, councilSW, councilNE, councilSE];
      await Promise.all(TXD_WINDOWS.council.map((seat, index) => this.tag(councilPanes[index]!, seat)));
      await this.applyCouncilGeometry(`${TXD_SESSION}:=council`);

      for (const page of ['palace_fleet', 'somnium_fleet'] as const) {
        const pane = await this.estateChecked(
          ['new-window', '-d', '-P', '-F', '#{pane_id}', ...this.paneEnvironment(TXD_STACK_WINDOWS[page]), '-c', this.homeDirectory(), '-t', TXD_SESSION, '-n', page],
          `create ${page} window`,
          page,
        );
        await this.tag(pane, TXD_STACK_WINDOWS[page]);
      }

      // Construction owns an empty socket and every pane it just made. A shape
      // that is still wrong here is not estate drift to be enforced away — it
      // is a broken constructor, so roll the whole session back and say why.
      const divergence = this.canonicalDivergence(await this.estateRows());
      if (divergence) throw new Error(`txd canonical estate construction postcondition failed: ${divergence}`);
      return { state: 'created', rebuilt_pages: Object.keys(TXD_WINDOWS) as TxdPage[], diverged_pages: [] };
    } catch (error) {
      if (sessionCreated) await this.command('rollback_estate', 'estate', ['kill-session', '-t', TXD_SESSION]);
      throw error;
    }
  }

  async createSeat(seatId: string): Promise<void> {
    if (!(await this.reachable())) {
      throw new Error('txd tmux server is not externally owned; refusing to spawn it inside txd');
    }
    if (!(await this.clearDefaultAgentEnvironment())) {
      throw new Error('txd tmux createSeat could not clear the server agent environment');
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

  async createStackSeat(page: string, seatId: string): Promise<void> {
    if (!isStackPage(page) || !seatBelongsToPage(page, seatId)) {
      throw new Error(`txd tmux refused non-mitosis seat ${seatId} on ${page}`);
    }
    if (!(await this.reachable())) {
      throw new Error('txd tmux server is not externally owned; refusing to spawn it inside txd');
    }
    if (!(await this.clearDefaultAgentEnvironment())) {
      throw new Error('txd tmux createStackSeat could not clear the server agent environment');
    }
    const target = `${TXD_SESSION}:=${page}`;
    const paneId = await this.checked([
      'split-window', '-d', '-P', '-F', '#{pane_id}',
      ...this.paneEnvironment(seatId), '-c', this.homeDirectory(), '-t', target,
    ], `split ${seatId}`, page);
    try {
      await this.tag(paneId, seatId);
      const tagged = await this.command('verify_stack_seat_tag', seatId, [
        'list-panes', '-t', target, '-F', `#{pane_id}\t#{${CANON_OPT}}`,
      ]);
      const witnessed = tagged.stdout.trim().split('\n').some((row) => row === `${paneId}\t${seatId}`);
      if (tagged.code !== 0 || !witnessed) {
        throw new Error(`txd tmux canonical tag verification failed for ${seatId}`);
      }
      // One topology mutation, one native rebalance. No dimensions or
      // positions cross this boundary.
      await this.checked(['select-layout', '-t', target, 'tiled'], `tile ${page}`, page);
    } catch (error) {
      await this.command('rollback_stack_seat', seatId, ['kill-pane', '-t', paneId]);
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
    if (!(await this.clearDefaultAgentEnvironment(paneId))) return false;
    // -k kills the pane's current command while reusing the pane and its
    // @canonical_id option. tmux 3.5a does not preserve the pane-local
    // environment across respawn, so the physical authority must restamp the
    // same canonical PANE_ID on every replacement process.
    const r = await this.command('reap_seat', seatId, [
      'respawn-pane', '-k', ...this.paneEnvironment(seatId), '-t', paneId,
      '/usr/bin/env', '-u', AGENT_ID_ENV, `${PANE_ID_ENV}=${seatId}`, shell,
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
    if (!(await this.clearDefaultAgentEnvironment(paneId))) return false;
    if ((await this.command('reset_seat_process', seatId, [
      'respawn-pane', '-k', ...this.paneEnvironment(seatId), '-t', paneId,
      '/usr/bin/env', '-u', AGENT_ID_ENV, `${PANE_ID_ENV}=${seatId}`, shell,
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
    const target = `${TXD_SESSION}:=${page}`;
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
    const repairedCouncilRows = page === 'council' && spec && anchors.has(spec.source)
      ? await this.councilRows(sourcePane)
      : null;
    const councilSize = repairedCouncilRows
      ? repairedCouncilRows[seatId === 'council:custodes' || seatId === 'council:pax' ? 'top' : 'bottom']
      : null;
    const flags = spec && anchors.has(spec.source)
      ? [...spec.flags, ...(councilSize !== null ? ['-l', String(councilSize)] : spec.size ? ['-l', spec.size] : [])]
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
      `${LAUNCH_NONCE_ENV}=${this.shellQuote(launch.launchNonce)}`,
      ...(launch.sshTarget ? [`${SSH_TARGET_ENV}=${this.shellQuote(launch.sshTarget)}`] : []),
    ].join(' ');
    const command = [
      `exec /usr/bin/env ${environment}`,
      this.shellQuote(launch.wrapper),
      this.shellQuote(launch.engine),
      ...(launch.engine === 'claude'
        ? [this.shellQuote('--session-id'), this.shellQuote(launch.launchNonce)]
        : []),
      ...(launch.prompt === undefined ? [] : [this.shellQuote(launch.prompt)]),
    ].join(' ');
    const result = await this.command('start_seat_engine', launch.seatId, [
      'respawn-pane', '-k',
      ...this.paneEnvironment(launch.seatId, launch.agentId), '-t', paneId, command,
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
    return this.generationForPane(seatId, paneId);
  }

  private async generationForPane(seatId: string, paneId: string): Promise<string | undefined> {
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

  private static activeComposerPaint(pane: string): { text: string; dimOnly: boolean } | null {
    const rawLines = pane.split('\n');
    const lines = rawLines.map(stripAnsi);
    let promptLine = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\s*[│┃]?\s*[›❯>]\s?/.test(lines[index]!)) {
        promptLine = index;
        break;
      }
    }
    if (promptLine < 0) return null;

    const isClaudeComposerBoundary = (index: number): boolean =>
      // Wide Claude panes render the session name inside this border; narrow
      // panes collapse it to a bare rule. Both are the same editor boundary.
      /^\s*[─━]{3,}(?:[^─━].*[─━]{2,})?\s*$/.test(lines[index]!)
      && lines.slice(index + 1, index + 3).some((line) =>
        /Context .* used|bypass permissions on|for shortcuts|← for agents/.test(line));
    let promptBlockEnd = promptLine + 1;
    while (promptBlockEnd < lines.length
      && lines[promptBlockEnd]!.trim() !== ''
      // Claude 2.1.233 paints the lower composer border immediately after the
      // active prompt, with no blank row before its status chrome. That border
      // terminates the editor; folding it into the payload makes both a truly
      // empty composer and an intact pasted frame look corrupted.
      // Opaque payload may itself contain a horizontal-rule line, so the rule
      // is a boundary only when Claude's adjacent status chrome attests it.
      && !isClaudeComposerBoundary(promptBlockEnd)) promptBlockEnd += 1;
    const promptBlock = lines.slice(promptLine, promptBlockEnd);
    promptBlock[0] = promptBlock[0]!.replace(/^\s*[│┃]?\s*[›❯>]\s?/, '');
    const text = promptBlock.map((line) => line.replace(/^\s*[│┃]\s?/, '')).join('\n');

    // `capture-pane -e` preserves Claude's SGR 2 paint. Claude uses dim text
    // after the active prompt exclusively for a tab-to-accept suggestion; it
    // is editor chrome and no input byte has been committed. tmux's ordinary
    // capture erases that distinction, which made suggestion paint look like
    // an operator draft. Observe the style, but keep it out of frame matching.
    const glyphs: Array<{ char: string; dim: boolean }> = [];
    const rawPromptBlock = rawLines.slice(promptLine, promptBlockEnd).join('\n');
    let dim = false;
    let cursor = 0;
    for (const match of rawPromptBlock.matchAll(ANSI_CSI)) {
      for (const char of rawPromptBlock.slice(cursor, match.index)) glyphs.push({ char, dim });
      if (match[3] === 'm') {
        const params = match[1] === '' ? [0] : match[1]!.split(';').map((value) => Number.parseInt(value, 10));
        for (const param of params) {
          if (param === 0 || param === 22) dim = false;
          if (param === 2) dim = true;
        }
      }
      cursor = match.index + match[0].length;
    }
    for (const char of rawPromptBlock.slice(cursor)) glyphs.push({ char, dim });
    const marker = glyphs.findIndex(({ char }) => /[›❯>]/u.test(char));
    const payloadGlyphs = marker < 0 ? [] : glyphs.slice(marker + 1);
    if (payloadGlyphs[0] && /\s/u.test(payloadGlyphs[0].char)) payloadGlyphs.shift();
    const contentGlyphs = payloadGlyphs.filter(({ char }) => !/[\s│┃]/u.test(char));
    return { text, dimOnly: contentGlyphs.length > 0 && contentGlyphs.every(({ dim: paintedDim }) => paintedDim) };
  }

  private static activeComposer(pane: string): string | null {
    return RealTmux.activeComposerPaint(pane)?.text ?? null;
  }

  /**
   * The composer verdict, pure and pinned: does the ACTIVE prompt hold exactly
   * this frame (or an exact engine-native receipt for it)? Chrome glyphs and
   * wrapping are presentation, not payload. A matching substring inside a
   * larger painted composer is never sufficient evidence.
   */
  static composerVerdict(pane: string, _messageId: string, expectedFrame: string): ComposerVerdict {
    const normalize = (text: string) => text.replace(/[│┃]/g, '').replace(/\s+/g, '');
    const expected = normalize(expectedFrame);
    const composer = RealTmux.activeComposer(pane);
    if (composer === null) return 'absent';
    const visibleRegion = normalize(composer);

    // Codex's multiline composer is a viewport. Narrow panes can clip the
    // frame's first rows after extra TUI chrome (for example the background
    // terminal status) reduces the textarea height. The last prompt-marked
    // region is still the editor, and an exact, substantial visible suffix is
    // enough to prove that the editor owns the intended bytes. Chrome below
    // the textarea is deliberately ignored by taking only the longest prefix
    // of that region which is an expected-frame suffix.
    // Codex deliberately collapses a bracketed multi-KB paste into one native
    // composer receipt instead of painting the payload. tmux has already
    // proven the exact stdin-loaded buffer and atomic paste-buffer operation;
    // this receipt is the engine-side acknowledgement that it accepted that
    // paste. Accept only the whole, otherwise-empty active prompt line and an
    // exact Unicode-scalar count. A lookalike embedded in ordinary payload
    // text, or any count mismatch, remains corruption.
    const collapsedPaste = visibleRegion
      .match(/^\[PastedContent(\d+)chars\]$/);
    if (collapsedPaste) {
      return Number(collapsedPaste[1]) === [...expectedFrame].length ? 'intact' : 'corrupted';
    }

    // Claude collapses a bracketed multiline paste to a numbered native
    // receipt. The ordinal identifies Claude's paste attachment, while the
    // `+N lines` count is the exact number of newlines accepted from the
    // already-attested tmux buffer. Accept only the whole, otherwise-empty
    // composer receipt with the expected line shape. A receipt embedded in a
    // draft, or one for a differently shaped paste, is corruption.
    const claudeCollapsedPaste = visibleRegion
      .match(/^\[Pastedtext#\d+\+(\d+)lines\]$/);
    if (claudeCollapsedPaste) {
      const expectedNewlines = expectedFrame.match(/\n/g)?.length ?? 0;
      return Number(claudeCollapsedPaste[1]) === expectedNewlines ? 'intact' : 'corrupted';
    }

    if (visibleRegion === expected) return 'intact';
    const minimumProofLength = 32;
    if (visibleRegion.length >= minimumProofLength && expected.endsWith(visibleRegion)) return 'intact';
    return 'corrupted';
  }

  static inputVerdict(pane: string, expected: string): ComposerVerdict {
    return RealTmux.composerVerdict(pane, '', expected);
  }

  static composerInteractive(pane: string): boolean {
    const lines = pane.split('\n').map(stripAnsi);
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

  sendVerifiedToSeat(seatId: string, correlationId: string, text: string, tabAfterPrefix?: string, engine?: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    return this.serializePaneInput(seatId, () =>
      this.sendVerifiedToSeatUnlocked(seatId, correlationId, text, tabAfterPrefix, engine, expectedPaneGeneration));
  }

  private async sendVerifiedToSeatUnlocked(seatId: string, _correlationId: string, text: string, tabAfterPrefix?: string, _engine?: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'seat_unresolved' as const };
    if (expectedPaneGeneration !== undefined
      && await this.generationForPane(seatId, paneId) !== expectedPaneGeneration) {
      return { bytes: 0, verdict: 'seat_unresolved' as const };
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const prefix = tabAfterPrefix ?? text;
    const suffix = tabAfterPrefix === undefined ? '' : text.slice(tabAfterPrefix.length);
    if (!await this.pasteLiteral(seatId, paneId, prefix, 'paste_literal')) {
      return { bytes: Buffer.byteLength(prefix, 'utf8'), verdict: 'transport_failed' };
    }
    if (tabAfterPrefix !== undefined) {
      const tab = await this.command('commit_surface_name', seatId, ['send-keys', '-t', paneId, 'Tab']);
      if (tab.code !== 0) return { bytes: Buffer.byteLength(prefix, 'utf8'), verdict: 'transport_failed' };
      if (suffix.length > 0 && !await this.pasteLiteral(seatId, paneId, suffix, 'paste_literal_args')) {
        return { bytes, verdict: 'transport_failed' };
      }
    }
    const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
    return enter.code === 0
      ? { bytes, verdict: 'staged' }
      : { bytes, verdict: 'submit_failed' };
  }

  /**
   * The composer-at-rest observation: one capture, judged by the pinned
   * `composerVerdict`, taken when the caller holds a real at-rest event (the
   * target's stop). `intact` → the frame still sits un-submitted. `corrupted`
   * → a visible composer holds something else, so the frame left it. `absent`
   * (no visible composer) and a failed capture prove nothing.
   */
  async observeFrameAbsence(seatId: string, expectedFrame: string): Promise<FrameRestObservation> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return 'unobservable';
    const captured = await this.command('observe_frame_at_rest', seatId, [
      'capture-pane', '-p', '-e', '-J', '-t', paneId,
    ]);
    if (captured.code !== 0) return 'unobservable';
    const verdict = RealTmux.composerVerdict(captured.stdout, '', expectedFrame);
    if (verdict === 'intact') return 'frame_present';
    return verdict === 'corrupted' ? 'frame_absent' : 'unobservable';
  }

  /**
   * The lost-Enter completion (live specimen 29fb6cc0). Observation and Enter
   * share one serialized pane transaction so no other staging can interleave
   * between the evidence and the keypress: the at-rest capture must show the
   * ACTIVE composer holding exactly the staged frame — the payload observably
   * arrived and observably never left — and only then is one Enter driven for
   * the transaction that staged it. Anything else refuses with zero effect.
   */
  completeStagedSubmit(seatId: string, expectedFrame: string, expectedPaneGeneration?: string): Promise<StagedSubmitCompletion> {
    return this.serializePaneInput(seatId, async () => {
      const paneId = await this.resolvePane(seatId);
      if (!paneId) return 'seat_unresolved';
      if (expectedPaneGeneration !== undefined
        && await this.generationForPane(seatId, paneId) !== expectedPaneGeneration) {
        return 'seat_unresolved';
      }
      const captured = await this.command('observe_frame_at_rest', seatId, [
        'capture-pane', '-p', '-e', '-J', '-t', paneId,
      ]);
      if (captured.code !== 0) return 'unobservable';
      const verdict = RealTmux.composerVerdict(captured.stdout, '', expectedFrame);
      if (verdict === 'absent') return 'unobservable';
      if (verdict === 'corrupted') return 'frame_absent';
      const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
      return enter.code === 0 ? 'submit_completed' : 'submit_failed';
    });
  }

  /**
   * The shell-mode composer verdict. Claude's bash mode repaints the prompt
   * marker itself as `!`; a paint that keeps the standard caret shows the bang
   * as leading text instead. Both prove the same staged bytes; anything else
   * painted is corruption.
   */
  static shellComposerVerdict(pane: string, command: string): ComposerVerdict {
    const normalize = (text: string) => text.replace(/[│┃]/g, '').replace(/\s+/g, '');
    const expected = normalize(command);
    const candidates: string[] = [];
    const bang = RealTmux.bangComposer(pane);
    if (bang !== null) candidates.push(bang);
    const active = RealTmux.activeComposer(pane);
    if (active !== null) candidates.push(active);
    if (candidates.length === 0) return 'absent';
    for (const candidate of candidates) {
      let visible = normalize(candidate);
      if (visible.startsWith('!')) visible = visible.slice(1);
      if (visible === expected) return 'intact';
      const minimumProofLength = 32;
      if (visible.length >= minimumProofLength && expected.endsWith(visible)) return 'intact';
    }
    return 'corrupted';
  }

  /** The bash-mode prompt block: like activeComposer, with `!` as the marker. */
  private static bangComposer(pane: string): string | null {
    const lines = pane.split('\n');
    let promptLine = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\s*[│┃]?\s*!\s?/.test(lines[index]!)) {
        promptLine = index;
        break;
      }
    }
    if (promptLine < 0) return null;
    let promptBlockEnd = promptLine + 1;
    while (promptBlockEnd < lines.length && lines[promptBlockEnd]!.trim() !== '') promptBlockEnd += 1;
    const promptBlock = lines.slice(promptLine, promptBlockEnd);
    promptBlock[0] = promptBlock[0]!.replace(/^\s*[│┃]?\s*!\s?/, '');
    return promptBlock.map((line) => line.replace(/^\s*[│┃]\s?/, '')).join('\n');
  }

  runInAgentComposer(seatId: string, runId: string, command: string, engine: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    if (engine === 'codex') {
      // Codex parses a literal `!`-prefixed composer line at submit, so the
      // whole form rides the ordinary verified send path — which serializes
      // on the seat's pane-input queue itself.
      return this.sendVerifiedToSeat(seatId, runId, `!${command}`, undefined, 'codex', expectedPaneGeneration);
    }
    return this.serializePaneInput(seatId, () =>
      this.runInAgentComposerUnlocked(seatId, command, expectedPaneGeneration));
  }

  private async runInAgentComposerUnlocked(seatId: string, command: string, expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    // Claude: the `!` must be a KEYSTROKE on the interactive composer —
    // a bracketed paste of `!` stays text and would submit a prompt instead
    // of entering bash mode.
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'seat_unresolved' as const };
    if (expectedPaneGeneration !== undefined
      && await this.generationForPane(seatId, paneId) !== expectedPaneGeneration) {
      return { bytes: 0, verdict: 'seat_unresolved' as const };
    }
    const bytes = Buffer.byteLength(command, 'utf8');
    const bang = await this.command('enter_shell_mode', seatId, ['send-keys', '-t', paneId, '-l', '!']);
    if (bang.code !== 0) return { bytes: 0, verdict: 'transport_failed' };
    if (!await this.pasteLiteral(seatId, paneId, command, 'paste_literal_run')) {
      return { bytes: 1, verdict: 'transport_failed' };
    }
    const enter = await this.command('submit_enter', seatId, ['send-keys', '-t', paneId, 'Enter']);
    return enter.code === 0
      ? { bytes, verdict: 'staged' }
      : { bytes, verdict: 'submit_failed' };
  }

  async runInShellPane(seatId: string, runId: string, command: string, signal: AbortSignal): Promise<ShellRunStaged> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) throw new Error(`seat_unresolved: ${seatId}`);
    const workload = (await this.workloads()).find((entry) => entry.seat_id === seatId);
    if (!workload) throw new Error(`seat_unresolved: ${seatId}`);
    if (!workload.idle) throw new Error(`pane_busy: ${workload.command}`);
    // /tmp is one shared namespace with the pane shells by pinned unit
    // contract (no PrivateTmp — test/systemd-unit.test.ts), so the command's
    // own redirections write files this daemon can harvest.
    const dir = await mkdtemp(join(tmpdir(), 'txd-run-'));
    const script = join(dir, 'run.sh');
    const stdoutPath = join(dir, 'stdout');
    const stderrPath = join(dir, 'stderr');
    const codePath = join(dir, 'code');
    await writeFile(script, `${command}\n`, { mode: 0o700 });
    const channel = `txd-run-${runId}`;
    // A local scope over the caller's signal, so a refused staging can retire
    // the armed waiter: no line was typed, so nothing will ever signal its
    // channel, and an unaborted client would sit on the tmux server forever.
    const waitScope = new AbortController();
    const relay = () => waitScope.abort();
    if (signal.aborted) waitScope.abort();
    else signal.addEventListener('abort', relay, { once: true });
    // Armed BEFORE the line is staged, so the completion signal can never
    // fire unobserved.
    const waiter = this.waitFor(this.socket, channel, waitScope.signal);
    waiter.catch(() => {});
    // The command itself lives in the script file, so the one staged line
    // carries only fixed paths — no quoting hazard can break the epilogue
    // that signals completion.
    const line = `bash ${script} >${stdoutPath} 2>${stderrPath}; printf '%s' "$?" >${codePath}; tmux -L ${this.socket} wait-for -S ${channel}`;
    const staged = await this.pasteLiteral(seatId, paneId, line, 'run_shell_line');
    const enter = staged ? await this.command('run_shell_submit', seatId, ['send-keys', '-t', paneId, 'Enter']) : null;
    if (!staged || enter?.code !== 0) {
      signal.removeEventListener('abort', relay);
      waitScope.abort();
      await rm(dir, { recursive: true, force: true });
      throw new Error(`stage_failed: ${seatId}`);
    }
    const completion = (async (): Promise<ShellRunOutcome> => {
      try {
        await waiter;
        const [exitCode, stdout, stderr] = await Promise.all([
          readFile(codePath, 'utf8').then((value) => Number(value.trim())).catch(() => Number.NaN),
          readCapturedStream(stdoutPath),
          readCapturedStream(stderrPath),
        ]);
        if (!Number.isInteger(exitCode)) throw new Error(`run_exit_unreadable: ${seatId}`);
        return {
          exit_code: exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdout_truncated: stdout.truncated,
          stderr_truncated: stderr.truncated,
        };
      } catch (error) {
        if (signal.aborted) throw new Error(`pane_lost_mid_run: ${seatId}`);
        throw error;
      } finally {
        signal.removeEventListener('abort', relay);
        await rm(dir, { recursive: true, force: true });
      }
    })();
    return { completion };
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
  private geometryDrift = new Set<string>();
  /** Test control: the page keeps every seat live but loses its declared geometry. */
  driftPageGeometry(page: TxdPage): void { this.geometryDrift.add(page); }
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
  private lifecycleHooks = { pane_died: false, pane_exited: false };

  async reachable(): Promise<boolean> {
    return this.reachableFlag;
  }
  async ensureLifecycleHooks(): Promise<void> {
    this.lifecycleHooks = { pane_died: true, pane_exited: true };
  }
  async lifecycleHookReadiness(): Promise<LifecycleHookReadiness> {
    const { pane_died, pane_exited } = this.lifecycleHooks;
    return { state: pane_died && pane_exited ? 'ready' : 'degraded', pane_died, pane_exited };
  }
  stripLifecycleHooks(): void {
    this.lifecycleHooks = { pane_died: false, pane_exited: false };
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
  async commitClipboardSelection(text: string, clientTty: string): Promise<ClipboardOriginOutcome> {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (!this.attachedClients.has(clientTty)) return { outcome: 'disconnected_origin', bytes };
    if (bytes === 0) return { outcome: 'transport_refused', origin: 'wsl', bytes };
    await this.loadClipboard(text);
    this.deliveredSelections.push(clientTty);
    return { outcome: 'delivered', origin: 'wsl', bytes };
  }
  setCommand(seatId: string, command: string): void { this.commands.set(seatId, command); }
  async listSeats(): Promise<SeatObservation[]> {
    return [...this.seats].map(([seat_id, s]) => ({ seat_id, pane: s.pane }));
  }
  async seatReadiness(): Promise<SeatReadinessObservation[]> {
    return [...this.seats].map(([seat_id, seat]) => ({
      seat_id,
      pane: seat.pane,
      tint: seat.pane === 'live' ? this.tints.get(seat_id) ?? null : undefined,
      generation: seat.generation,
    }));
  }
  private fakePageDivergence(page: TxdPage, expected: readonly string[]): PageDivergence | null {
    const shaped = this.shape.windows[page] ?? [];
    const live = shaped.filter((seat) => this.seats.get(seat)?.pane === 'live');
    const dead = shaped.filter((seat) => this.seats.get(seat)?.pane === 'dead');
    const missing = expected.filter((seat) => !shaped.includes(seat));
    const unexpected = isStackPage(page) ? [] : live.filter((seat) => !expected.includes(seat));
    const duplicates = [...new Set(shaped.filter((seat, index) => shaped.indexOf(seat) !== index))];
    const foreign = shaped.filter((seat) => !seatBelongsToPage(page, seat));
    if (missing.length === 0 && dead.length === 0 && unexpected.length === 0 && duplicates.length === 0 && foreign.length === 0) {
      return this.geometryDrift.has(page)
        ? { page, clause: 'geometry', detail: `page ${page} geometry is not canonical` }
        : null;
    }
    const render = (list: string[]): string => (list.length === 0 ? 'none' : list.join(', '));
    return {
      page,
      clause: 'seats',
      detail: `missing: ${render(missing)}; dead: ${render(dead)}; unexpected: ${render([...unexpected, ...foreign])}; duplicates: ${render(duplicates)}`,
    };
  }
  async estateDivergences(): Promise<PageDivergence[]> {
    if (this.shape.sessions.length === 0) return [];
    return Object.entries(TXD_WINDOWS).flatMap(([page, expected]) => {
      const divergence = this.fakePageDivergence(page as TxdPage, expected);
      return divergence ? [divergence] : [];
    });
  }
  async ensureEstate(): Promise<EstateEnsureResult> {
    await this.ensureLifecycleHooks();
    if (this.shape.sessions.length > 0) {
      const recoverable = this.shape.sessions.length === 1 && this.shape.sessions[0] === TXD_SESSION
        && Object.entries(this.shape.windows).every(([page, seats]) => {
          return Object.hasOwn(TXD_WINDOWS, page) && seats.every((seat) => seatBelongsToPage(page, seat));
        });
      if (!recoverable) throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
      const rebuilt_pages: TxdPage[] = [];
      const diverged_pages: PageDivergence[] = [];
      for (const [name, expectedSeats] of Object.entries(TXD_WINDOWS)) {
        const page = name as TxdPage;
        if (this.fakePageDivergence(page, expectedSeats) === null) continue;
        const shaped = this.shape.windows[page] ?? [];
        const live = shaped.filter((seat) => this.seats.get(seat)?.pane === 'live');
        if (isStackPage(page)) {
          const allocation = shaped.filter((seat) => seat === TXD_STACK_WINDOWS[page]);
          if (allocation.length === 1 && this.seats.get(allocation[0]!)?.pane === 'dead') {
            await this.resetSeat(allocation[0]!);
          } else if (allocation.length === 0 && live.length > 0) {
            await this.createStackSeat(page, TXD_STACK_WINDOWS[page]);
          }
        }
        if (live.length > 0) {
          const divergence = this.fakePageDivergence(page, expectedSeats);
          if (divergence) diverged_pages.push(divergence);
          continue;
        }
        if (!(await this.rebuildPage(page))) throw new Error(`FakeTmux: failed page reconstruction ${page}`);
        rebuilt_pages.push(page);
      }
      return { state: 'existing', rebuilt_pages, diverged_pages };
    }
    this.shape = {
      sessions: [TXD_SESSION],
      windows: Object.fromEntries(Object.entries(TXD_WINDOWS).map(([window, seats]) => [window, [...seats]])),
    };
    for (const seat of TXD_ESTATE) this.seats.set(seat, { pane: 'live', generation: crypto.randomUUID() });
    return { state: 'created', rebuilt_pages: Object.keys(TXD_WINDOWS) as TxdPage[], diverged_pages: [] };
  }
  async estateGeneration(): Promise<EstateGeneration> {
    if (this.shape.sessions.length === 0) return 'empty';
    const canonical = Object.entries(TXD_WINDOWS).every(([page, required]) => {
      const observed = this.shape.windows[page] ?? [];
      return required.every((seat) => observed.filter((candidate) => candidate === seat).length === 1)
        && observed.every((seat) => seatBelongsToPage(page, seat) && this.seats.get(seat)?.pane === 'live');
    });
    if (canonical && this.geometryDrift.size === 0) return 'canonical';
    const recoverable = Object.entries(this.shape.windows).every(([page, seats]) => {
      return Object.hasOwn(TXD_WINDOWS, page) && seats.every((seat) => seatBelongsToPage(page, seat));
    });
    return recoverable ? 'recoverable' : 'foreign';
  }
  estateShape(): { sessions: string[]; windows: Record<string, string[]> } {
    return structuredClone(this.shape);
  }
  seedNonCanonicalEstate(): void {
    this.shape = { sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } };
    this.seats.set('palace:W', { pane: 'live', generation: crypto.randomUUID() });
  }
  async createSeat(seatId: string): Promise<void> {
    // Test control: a configured seat throws (simulates a below-membrane tmux
    // failure), exercising the constructor's per-seat isolation.
    if (this.failCreate.has(seatId)) throw new Error(`FakeTmux: forced createSeat failure for ${seatId}`);
    this.seats.set(seatId, { pane: 'live', generation: crypto.randomUUID() });
  }
  async createStackSeat(page: string, seatId: string): Promise<void> {
    if (!isStackPage(page) || !seatBelongsToPage(page, seatId)) {
      throw new Error(`FakeTmux: refused non-mitosis seat ${seatId} on ${page}`);
    }
    if (this.failCreate.has(seatId)) throw new Error(`FakeTmux: forced createSeat failure for ${seatId}`);
    const seats = this.shape.windows[page];
    if (!seats) throw new Error(`FakeTmux: absent mitosis page ${page}`);
    seats.push(seatId);
    this.seats.set(seatId, { pane: 'live', generation: crypto.randomUUID() });
  }
  /** Test control: force createSeat(seatId) to throw. */
  failCreateSeat(seatId: string): void {
    this.failCreate.add(seatId);
  }
  async killSeat(seatId: string): Promise<void> {
    const s = this.seats.get(seatId);
    if (!s) return;
    const [page] = seatId.split(':', 1);
    if (page && isStackPage(page) && !TXD_ESTATE.includes(seatId)) {
      this.seats.delete(seatId);
      this.commands.delete(seatId);
      this.seatEngines.delete(seatId);
      this.tints.delete(seatId);
      if (this.shape.windows[page]) {
        this.shape.windows[page] = this.shape.windows[page]!.filter((seat) => seat !== seatId);
      }
      return;
    }
    s.pane = 'dead';
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
    if (isStackPage(page)) {
      const existing = this.shape.windows[page] ?? [];
      if (existing.some((seat) => this.seats.get(seat)?.pane === 'live')) {
        return TXD_WINDOWS[page].every((seat) => existing.filter((candidate) => candidate === seat).length === 1
            && this.seats.get(seat)?.pane === 'live')
          && existing.every((seat) => seatBelongsToPage(page, seat) && this.seats.get(seat)?.pane === 'live');
      }
    }
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
    this.geometryDrift.delete(page);
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

  /**
   * The composer-at-rest observation over this fake's pane text. A seat with
   * no pane text configured proves nothing — a test must paint the composer,
   * exactly as the real capture demands evidence.
   */
  async observeFrameAbsence(seatId: string, expectedFrame: string): Promise<FrameRestObservation> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return 'unobservable';
    const pane = this.paneTexts.get(seatId);
    if (pane === undefined) return 'unobservable';
    const verdict = RealTmux.composerVerdict(pane, '', expectedFrame);
    if (verdict === 'intact') return 'frame_present';
    return verdict === 'corrupted' ? 'frame_absent' : 'unobservable';
  }

  async sendVerifiedToSeat(seatId: string, _correlationId: string, text: string, _tabAfterPrefix?: string, _engine?: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead' || (expectedPaneGeneration !== undefined && s.generation !== expectedPaneGeneration)) {
      return { bytes: 0, verdict: 'seat_unresolved' as const };
    }
    this.sentLines.set(seatId, [...(this.sentLines.get(seatId) ?? []), text]);
    return { bytes: Buffer.byteLength(text, 'utf8'), verdict: 'staged' as const };
  }

  private enterDrives = new Map<string, number>();
  /** Test observation: how many lost-Enter completions drove Enter on this seat. */
  entersDriven(seatId: string): number { return this.enterDrives.get(seatId) ?? 0; }
  async completeStagedSubmit(seatId: string, expectedFrame: string, expectedPaneGeneration?: string): Promise<StagedSubmitCompletion> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead' || (expectedPaneGeneration !== undefined && s.generation !== expectedPaneGeneration)) {
      return 'seat_unresolved';
    }
    const pane = this.paneTexts.get(seatId);
    if (pane === undefined) return 'unobservable';
    const verdict = RealTmux.composerVerdict(pane, '', expectedFrame);
    if (verdict === 'absent') return 'unobservable';
    if (verdict === 'corrupted') return 'frame_absent';
    this.enterDrives.set(seatId, (this.enterDrives.get(seatId) ?? 0) + 1);
    return 'submit_completed';
  }
  async observeComposerInteractive(seatId: string): Promise<boolean> {
    const s = this.seats.get(seatId);
    return !!s && s.pane === 'live'
      && RealTmux.composerInteractive(this.paneTexts.get(seatId) ?? '');
  }
  private agentRuns: Array<{ seat_id: string; run_id: string; command: string; engine: 'claude' | 'codex' }> = [];
  private agentRunFailures = new Set<string>();
  private shellRuns: Array<{ seat_id: string; run_id: string; command: string }> = [];
  private shellRunResults = new Map<string, ShellRunOutcome>();
  private heldShellRuns = new Set<string>();
  /** Test control: the seat's composer refuses the shell-escape staging. */
  failAgentRun(seatId: string): void { this.agentRunFailures.add(seatId); }
  /** Test observation: every agent-composer shell escape staged, in order. */
  agentComposerRuns(): Array<{ seat_id: string; run_id: string; command: string; engine: 'claude' | 'codex' }> {
    return [...this.agentRuns];
  }
  /** Test observation: every bare-pane shell run staged, in order. */
  paneShellRuns(): Array<{ seat_id: string; run_id: string; command: string }> { return [...this.shellRuns]; }
  /** Test control: what the seat's next shell run harvests. */
  setShellRunResult(seatId: string, outcome: ShellRunOutcome): void { this.shellRunResults.set(seatId, outcome); }
  /** Test control: the seat's shell run never completes on its own (abort paths). */
  holdShellRun(seatId: string): void { this.heldShellRuns.add(seatId); }
  async runInAgentComposer(seatId: string, runId: string, command: string, engine: 'claude' | 'codex', expectedPaneGeneration?: string): Promise<SendOutcome | { verdict: ComposerRefusal; bytes: number }> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead' || (expectedPaneGeneration !== undefined && s.generation !== expectedPaneGeneration)) {
      return { bytes: 0, verdict: 'seat_unresolved' as const };
    }
    if (this.agentRunFailures.has(seatId)) return { bytes: 0, verdict: 'transport_failed' as const };
    this.agentRuns.push({ seat_id: seatId, run_id: runId, command, engine });
    return { bytes: Buffer.byteLength(command, 'utf8'), verdict: 'staged' as const };
  }
  async runInShellPane(seatId: string, runId: string, command: string, signal: AbortSignal): Promise<ShellRunStaged> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') throw new Error(`seat_unresolved: ${seatId}`);
    const workload = (await this.workloads()).find((entry) => entry.seat_id === seatId);
    if (!workload) throw new Error(`seat_unresolved: ${seatId}`);
    if (!workload.idle) throw new Error(`pane_busy: ${workload.command}`);
    this.shellRuns.push({ seat_id: seatId, run_id: runId, command });
    const outcome = this.shellRunResults.get(seatId)
      ?? { exit_code: 0, stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false };
    const held = this.heldShellRuns.has(seatId);
    const completion = new Promise<ShellRunOutcome>((resolve, reject) => {
      const fail = () => reject(new Error(`pane_lost_mid_run: ${seatId}`));
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
      if (!held) queueMicrotask(() => resolve(outcome));
    });
    return { completion };
  }
  /** Test observation: every text staged into this seat, in order. */
  sends(seatId: string): string[] { return [...(this.sentLines.get(seatId) ?? [])]; }
  /** Test control: what the seat's visible pane currently shows. */
  setPaneText(seatId: string, text: string): void { this.paneTexts.set(seatId, text); }

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
