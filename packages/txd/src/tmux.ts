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

import { TXD_ESTATE, TXD_SESSION, TXD_WINDOWS } from './estate.ts';

export type SeatObservation = { seat_id: string; pane: 'live' | 'dead' };

export type SendTraceEvent = {
  kind: 'literal_insert' | 'submit_enter' | 'submit_verify';
  attempt: number;
  ok: boolean;
};

// Below-membrane delivery outcome (discriminated by verdict). `partial_delivered`
// = the literal text reached the pane but the submit (Enter) did not — first-class,
// never collapsed to failure. A total failure carries zero bytes by construction.
export type SendOutcome =
  | { verdict: 'delivered'; bytes: number; trace: SendTraceEvent[] }
  | { verdict: 'partial_delivered'; bytes: number; trace: SendTraceEvent[] }
  | { verdict: 'failed_none_delivered'; bytes: 0; trace: SendTraceEvent[] };

export interface TmuxControlPlane {
  reachable(): Promise<boolean>;
  version(): Promise<string | null>;
  /** Live seats as canonical ids + pane liveness. Never exposes %id. */
  listSeats(): Promise<SeatObservation[]>;
  /** Create the declared estate on an empty server, validate it if present, or refuse loud. */
  ensureEstate(): Promise<'created' | 'existing'>;
  /** Create a bare seat: a single-pane session tagged with the canonical id. */
  createSeat(seatId: string): Promise<void>;
  /** Kill the seat's pane (teardown). Idempotent. */
  killSeat(seatId: string): Promise<void>;
  /**
   * Reap the seat's agent PROCESS while KEEPING the estate pane: respawn the pane
   * bare (kill the running command, restart the shell). The pane id and its
   * canonical-id tag survive, so the seat stays in the estate and returns to the
   * freelist live+empty. Returns false if the pane could not be resolved/respawned
   * (caller must NOT attest process_reaped/seat_cleared on a failed reap).
   */
  reapSeat(seatId: string): Promise<boolean>;
  /**
   * Canonical ids of seats an attached client is actively on within windowMs —
   * a point-in-time READ of the server-maintained client_activity + active
   * pane. No shadow state, no keystroke hook.
   */
  presentSeats(windowMs: number, nowMs?: number): Promise<Set<string>>;
  /** Type text into the seat's pane. Reports full/partial/none delivery. Resolves %id below the membrane. */
  sendToSeat(seatId: string, text: string): Promise<SendOutcome>;
}

const CANON_OPT = '@canonical_id';

export type TmuxCommandResult = { code: number; stdout: string; stderr: string };
type TmuxRunner = (socket: string, args: string[]) => Promise<TmuxCommandResult>;
type Sleep = (ms: number) => Promise<void>;

async function run(socket: string, args: string[]): Promise<TmuxCommandResult> {
  const proc = Bun.spawn(['tmux', '-L', socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export class RealTmux implements TmuxControlPlane {
  private runner: TmuxRunner;
  private sleep: Sleep;
  private enterDelayMs: number;

  constructor(
    private socket: string,
    options: { run?: TmuxRunner; sleep?: Sleep; enterDelayMs?: number } = {},
  ) {
    this.runner = options.run ?? run;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    const configured = Number(process.env.TXD_SEND_ENTER_DELAY_MS);
    this.enterDelayMs = options.enterDelayMs
      ?? (Number.isFinite(configured) && configured >= 0 ? configured : 200);
  }

  async reachable(): Promise<boolean> {
    // Observation only: starting the server here would make it a child of the
    // sandboxed txd.service and propagate NoNewPrivileges to every estate pane.
    const r = await this.runner(this.socket, ['show-options', '-g', 'exit-empty']);
    return r.code === 0;
  }

  async version(): Promise<string | null> {
    const r = await this.runner(this.socket, ['-V']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Resolve canonical id -> internal %id (membrane; return value stays inside). */
  private async resolvePane(seatId: string): Promise<string | null> {
    const r = await this.runner(this.socket, ['list-panes', '-a', '-F', `#{pane_id}\t#{${CANON_OPT}}`]);
    if (r.code !== 0) return null;
    for (const line of r.stdout.split('\n')) {
      const [paneId, canon] = line.split('\t');
      if (canon === seatId && paneId) return paneId;
    }
    return null;
  }

  async listSeats(): Promise<SeatObservation[]> {
    const r = await this.runner(this.socket, ['list-panes', '-a', '-F', `#{${CANON_OPT}}\t#{pane_dead}`]);
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

  private async checked(args: string[], operation: string): Promise<string> {
    const result = await this.runner(this.socket, args);
    if (result.code !== 0) {
      throw new Error(`txd tmux ${operation} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout.trim();
  }

  private async estateRows(): Promise<Array<{ session: string; window: string; seat: string }>> {
    const result = await this.runner(this.socket, [
      'list-panes', '-a', '-F', `#{session_name}\t#{window_name}\t#{${CANON_OPT}}`,
    ]);
    if (result.code !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [session = '', window = '', seat = ''] = line.split('\t');
      return { session, window, seat };
    });
  }

  private isCanonicalEstate(rows: Array<{ session: string; window: string; seat: string }>): boolean {
    const expected = Object.entries(TXD_WINDOWS)
      .flatMap(([window, seats]) => seats.map((seat) => `${TXD_SESSION}\t${window}\t${seat}`))
      .sort();
    const actual = rows.map((row) => `${row.session}\t${row.window}\t${row.seat}`).sort();
    return actual.length === expected.length && actual.every((row, index) => row === expected[index]);
  }

  private async tag(paneId: string, seatId: string): Promise<void> {
    await this.checked(['set-option', '-p', '-t', paneId, CANON_OPT, seatId], `tag ${seatId}`);
  }

  async ensureEstate(): Promise<'created' | 'existing'> {
    if (!(await this.reachable())) {
      throw new Error('txd tmux server is not externally owned; tx-estate.service must start it before txd');
    }
    const rows = await this.estateRows();
    if (rows.length > 0) {
      if (this.isCanonicalEstate(rows)) return 'existing';
      throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
    }

    let sessionCreated = false;
    try {
      const reservistsW = await this.checked(
        ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', TXD_SESSION, '-n', 'reservists', '-x', '200', '-y', '60'],
        'create canonical session',
      );
      sessionCreated = true;
      const reservistsN = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', reservistsW, '-p', '70'], 'split reservists center');
      const reservistsE = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', reservistsN, '-p', '43'], 'split reservists east');
      const reservistsS = await this.checked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', reservistsN, '-p', '50'], 'split reservists south');
      await Promise.all([
        this.tag(reservistsW, 'reservists:W'), this.tag(reservistsN, 'reservists:N'),
        this.tag(reservistsS, 'reservists:S'), this.tag(reservistsE, 'reservists:E'),
      ]);

      const palaceW = await this.checked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'palace'],
        'create palace window',
      );
      const palaceN = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', palaceW, '-p', '70'], 'split palace center');
      const palaceE = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', palaceN, '-p', '43'], 'split palace east');
      const palaceS = await this.checked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', palaceN, '-p', '50'], 'split palace south');
      await Promise.all([
        this.tag(palaceW, 'palace:W'), this.tag(palaceN, 'palace:N'),
        this.tag(palaceS, 'palace:S'), this.tag(palaceE, 'palace:E'),
      ]);

      const somniumW = await this.checked(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'somnium'], 'create somnium window');
      const somniumN = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', somniumW, '-p', '70'], 'split somnium grid');
      const somniumNE = await this.checked(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', somniumN, '-p', '50'], 'split somnium east column');
      const somniumS = await this.checked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', somniumN, '-p', '50'], 'split somnium south');
      const somniumSE = await this.checked(['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', somniumNE, '-p', '50'], 'split somnium southeast');
      await Promise.all([
        this.tag(somniumW, 'somnium:W'), this.tag(somniumN, 'somnium:N'),
        this.tag(somniumS, 'somnium:S'), this.tag(somniumNE, 'somnium:NE'), this.tag(somniumSE, 'somnium:SE'),
      ]);

      const council = await this.checked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'council'],
        'create council window',
      );
      const councilPanes = [council];
      for (let index = 1; index < TXD_WINDOWS.council.length; index += 1) {
        councilPanes.push(await this.checked(
          ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', council],
          `split council seat ${index}`,
        ));
      }
      await Promise.all(TXD_WINDOWS.council.map((seat, index) => this.tag(councilPanes[index]!, seat)));

      const mechanicus = await this.checked(
        ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', TXD_SESSION, '-n', 'mechanicus'],
        'create mechanicus window',
      );
      const orchestrator = await this.checked(
        ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', mechanicus],
        'split mechanicus orchestrator',
      );
      await Promise.all([
        this.tag(mechanicus, TXD_WINDOWS.mechanicus[0]),
        this.tag(orchestrator, TXD_WINDOWS.mechanicus[1]),
      ]);

      if (!this.isCanonicalEstate(await this.estateRows())) throw new Error('txd canonical estate postcondition failed');
      return 'created';
    } catch (error) {
      if (sessionCreated) await this.runner(this.socket, ['kill-session', '-t', TXD_SESSION]);
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
    const created = await this.runner(this.socket, ['new-session', '-d', '-s', safe, '-x', '200', '-y', '50']);
    // Fail loud: if the session didn't come up, do NOT go on to list/retag some
    // other pane and record a seat that was never really created.
    if (created.code !== 0) {
      throw new Error(`txd tmux createSeat failed for ${seatId}: ${created.stderr.trim() || `exit ${created.code}`}`);
    }
    const paneR = await this.runner(this.socket, ['list-panes', '-t', safe, '-F', '#{pane_id}']);
    const paneId = paneR.stdout.trim().split('\n')[0];
    // A seat without its canonical-id tag is a broken seat. Tear the just-created
    // session back down (no orphan) before failing loud, rather than leave an
    // untagged pane the membrane can never resolve.
    if (!paneId) {
      await this.runner(this.socket, ['kill-session', '-t', safe]);
      throw new Error(`txd tmux createSeat: no pane for ${seatId} (session ${safe})`);
    }
    await this.runner(this.socket, ['set-option', '-p', '-t', paneId, CANON_OPT, seatId]);
  }

  async killSeat(seatId: string): Promise<void> {
    const paneId = await this.resolvePane(seatId);
    if (paneId) await this.runner(this.socket, ['kill-pane', '-t', paneId]);
  }

  async reapSeat(seatId: string): Promise<boolean> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return false;
    // -k kills the pane's current command; the pane (and its @canonical_id option)
    // is REUSED and a fresh default shell is started — the estate seat persists.
    const r = await this.runner(this.socket, ['respawn-pane', '-k', '-t', paneId]);
    return r.code === 0;
  }

  async presentSeats(windowMs: number, nowMs = Date.now()): Promise<Set<string>> {
    // Active pane (canonical) per session.
    const panes = await this.runner(this.socket, [
      'list-panes',
      '-a',
      '-F',
      `#{session_name}\t#{window_active}\t#{pane_active}\t#{${CANON_OPT}}`,
    ]);
    const activeCanonBySession = new Map<string, string>();
    for (const line of panes.stdout.split('\n')) {
      const [session, winActive, paneActive, canon] = line.split('\t');
      if (winActive === '1' && paneActive === '1' && session && canon) activeCanonBySession.set(session, canon);
    }
    // Attached clients + last activity (epoch seconds).
    const clients = await this.runner(this.socket, ['list-clients', '-F', '#{client_session}\t#{client_activity}']);
    const present = new Set<string>();
    const nowSec = Math.floor(nowMs / 1000);
    for (const line of clients.stdout.split('\n')) {
      const [session, activity] = line.split('\t');
      if (!session) continue;
      const canon = activeCanonBySession.get(session);
      const activitySec = Number(activity);
      if (canon && Number.isFinite(activitySec) && (nowSec - activitySec) * 1000 <= windowMs) present.add(canon);
    }
    return present;
  }

  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const paneId = await this.resolvePane(seatId);
    if (!paneId) return { bytes: 0, verdict: 'failed_none_delivered', trace: [] };
    const trace: SendTraceEvent[] = [];
    const literal = await this.runner(this.socket, ['send-keys', '-t', paneId, '-l', text]);
    trace.push({ kind: 'literal_insert', attempt: 1, ok: literal.code === 0 });
    if (literal.code !== 0) return { bytes: 0, verdict: 'failed_none_delivered', trace };
    const bytes = Buffer.byteLength(text, 'utf8');

    // The cursor's logical line is the cross-composer editable surface: shell,
    // Codex and Claude all leave swallowed input there. Once submitted, the
    // cursor moves to output or a fresh composer and this line no longer holds
    // the final non-empty line of the sent text.
    const verificationNeedle = text.split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
    const verify = async (attempt: number): Promise<boolean> => {
      const cursor = await this.runner(this.socket, ['display-message', '-p', '-t', paneId, '#{cursor_y}']);
      let ok = false;
      if (cursor.code === 0 && /^\d+$/.test(cursor.stdout.trim())) {
        const row = cursor.stdout.trim();
        const captured = await this.runner(this.socket, ['capture-pane', '-p', '-J', '-t', paneId, '-S', row, '-E', row]);
        ok = captured.code === 0 && verificationNeedle.length > 0 && !captured.stdout.includes(verificationNeedle);
      }
      trace.push({ kind: 'submit_verify', attempt, ok });
      return ok;
    };

    // One initial submit plus two bounded retries. Every Enter is separated
    // from the literal paste (and from prior retries) by a tunable backoff.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.sleep(this.enterDelayMs * attempt);
      const enter = await this.runner(this.socket, ['send-keys', '-t', paneId, 'Enter']);
      trace.push({ kind: 'submit_enter', attempt, ok: enter.code === 0 });
      if (enter.code === 0 && await verify(attempt)) return { bytes, verdict: 'delivered', trace };
      if (enter.code !== 0) trace.push({ kind: 'submit_verify', attempt, ok: false });
    }
    return { bytes, verdict: 'partial_delivered', trace };
  }
}

// In-memory fake for tests — same membrane contract, no tmux dependency.
export class FakeTmux implements TmuxControlPlane {
  private seats = new Map<string, { pane: 'live' | 'dead' }>();
  private present = new Map<string, number>(); // seat -> last activity epoch ms
  private failCreate = new Set<string>(); // seats whose createSeat is forced to throw
  private failReap = new Set<string>(); // seats whose reapSeat is forced to fail
  reachableFlag = true;
  private shape: { sessions: string[]; windows: Record<string, string[]> } = { sessions: [], windows: {} };

  async reachable(): Promise<boolean> {
    return this.reachableFlag;
  }
  async version(): Promise<string | null> {
    return 'tmux 3.5a (fake)';
  }
  async listSeats(): Promise<SeatObservation[]> {
    return [...this.seats].map(([seat_id, s]) => ({ seat_id, pane: s.pane }));
  }
  async ensureEstate(): Promise<'created' | 'existing'> {
    if (this.shape.sessions.length > 0) {
      const canonical = this.shape.sessions.length === 1 && this.shape.sessions[0] === TXD_SESSION
        && JSON.stringify(this.shape.windows) === JSON.stringify(TXD_WINDOWS);
      if (!canonical) throw new Error('txd refused non-canonical existing tmux estate; canonical construction requires an empty socket');
      return 'existing';
    }
    this.shape = {
      sessions: [TXD_SESSION],
      windows: Object.fromEntries(Object.entries(TXD_WINDOWS).map(([window, seats]) => [window, [...seats]])),
    };
    for (const seat of TXD_ESTATE) this.seats.set(seat, { pane: 'live' });
    return 'created';
  }
  estateShape(): { sessions: string[]; windows: Record<string, string[]> } {
    return structuredClone(this.shape);
  }
  seedNonCanonicalEstate(): void {
    this.shape = { sessions: ['seat_palace_W'], windows: { seat_palace_W: ['palace:W'] } };
    this.seats.set('palace:W', { pane: 'live' });
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
      for (const seat of seats) this.seats.set(seat, { pane: 'live' });
    }
  }
  async createSeat(seatId: string): Promise<void> {
    // Test control: a configured seat throws (simulates a below-membrane tmux
    // failure), exercising the constructor's per-seat isolation.
    if (this.failCreate.has(seatId)) throw new Error(`FakeTmux: forced createSeat failure for ${seatId}`);
    this.seats.set(seatId, { pane: 'live' });
  }
  /** Test control: force createSeat(seatId) to throw. */
  failCreateSeat(seatId: string): void {
    this.failCreate.add(seatId);
  }
  async killSeat(seatId: string): Promise<void> {
    const s = this.seats.get(seatId);
    if (s) s.pane = 'dead';
  }
  async reapSeat(seatId: string): Promise<boolean> {
    // Respawn keeps the pane LIVE (bare shell) — a live seat is reapable; a dead
    // or missing pane is not (nothing to respawn without a teardown+recreate).
    if (this.failReap.has(seatId)) return false;
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return false;
    s.pane = 'live';
    return true;
  }
  /** Test control: force reapSeat(seatId) to fail (simulates a wedged process). */
  failReapSeat(seatId: string): void {
    this.failReap.add(seatId);
  }
  /** Test control: kill a pane out-of-band (simulates a raw tmux kill). */
  killOutOfBand(seatId: string): void {
    const s = this.seats.get(seatId);
    if (s) s.pane = 'dead';
  }
  /** Test control: mark an operator active on a seat as of nowMs. */
  setPresence(seatId: string, atMs: number): void {
    this.present.set(seatId, atMs);
  }
  async presentSeats(windowMs: number, nowMs = Date.now()): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [seat, at] of this.present) if (nowMs - at <= windowMs) out.add(seat);
    return out;
  }
  async sendToSeat(seatId: string, text: string): Promise<SendOutcome> {
    const s = this.seats.get(seatId);
    if (!s || s.pane === 'dead') return { bytes: 0, verdict: 'failed_none_delivered', trace: [] };
    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      verdict: 'delivered',
      trace: [
        { kind: 'literal_insert', attempt: 1, ok: true },
        { kind: 'submit_enter', attempt: 1, ok: true },
        { kind: 'submit_verify', attempt: 1, ok: true },
      ],
    };
  }
}
