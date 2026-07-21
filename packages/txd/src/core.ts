// Daemon core — the domain logic behind the API (spec §4, §5, §6).
//
// Single writer: every mutating path runs under one async mutex so seq order
// and read-modify-write sequences never interleave. Truth is the event stream;
// this class only APPENDS facts and READS projections — it never mutates a
// projection directly.

import {
  SCHEMA_VERSION,
  SEND_PRESENCE_ACTIVITY_WINDOW_MS,
  type ActivityBoardRow,
  type CloseRequest,
  type CloseResponse,
  type CurrentBinding,
  type DeliveryVerdict,
  type EventInput,
  type Health,
  type LaunchRequest,
  type LaunchResponse,
  type OpenContradiction,
  type Provenance,
  type ProvenanceSource,
  type ReconcileResponse,
  type ReadinessRequest,
  type RouteRequest,
  type AxisResponse,
  type SendReceipt,
  type SendRefusal,
  type SendRefusalReason,
  type SendRequest,
  type SendResolution,
  type StopAutoCloseOutcome,
  type StopReceipt,
  type StopRefusal,
  type StopRefusalReason,
  type StopRequest,
  type SubscribeRequest,
  type SubscribeResponse,
} from '@terminus-os/contracts';
import type { EventStore } from './store.ts';
import { findTmuxId } from './ids.ts';
import { buildProjections, type Projections } from './projections.ts';
import { TXD_ESTATE } from './estate.ts';
import type { TmuxControlPlane } from './tmux.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const REQUIRED_REGISTRATION_FIELDS = [
  'instance_id', 'wrapper_id', 'engine', 'persona_id', 'rank', 'commander_type',
  'singleton_authority', 'dispatch_authority', 'session_doc_id', 'device_id',
  'working_dir', 'origin_type', 'execution_placement',
] as const;

export interface LaunchChain {
  startWrapper(req: LaunchRequest): Promise<void>;
  startEngineSession(req: LaunchRequest): Promise<void>;
  stopEngineSession(req: LaunchRequest): Promise<void>;
  stopWrapper(req: LaunchRequest): Promise<void>;
}
const noExternalLaunchChain: LaunchChain = {
  async startWrapper() {}, async startEngineSession() {}, async stopEngineSession() {}, async stopWrapper() {},
};

type Now = () => string;
type ScheduledCallback = () => void | Promise<void>;
type Schedule = (callback: ScheduledCallback, delayMs: number) => void;

const scheduleGuardRelease: Schedule = (callback, delayMs) => {
  const timer = setTimeout(() => void callback(), delayMs);
  timer.unref?.();
};

export class Daemon {
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(
    private store: EventStore,
    private tmux: TmuxControlPlane,
    private now: Now = () => new Date().toISOString(),
    private schedule: Schedule = scheduleGuardRelease,
    private nowMs: () => number = Date.now,
    private launchChain: LaunchChain = noExternalLaunchChain,
  ) {}

  /** Serialize a mutating op — the single-writer discipline. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private prov(source: ProvenanceSource, transportReceipt: string | null): Provenance {
    return { source, transport_receipt: transportReceipt, emitter_version: SCHEMA_VERSION };
  }

  private async projections(): Promise<Projections> {
    return buildProjections(await this.store.readAll());
  }

  // ── /agents/launch — authoritative registration chain ────────────────────
  launch(req: LaunchRequest, transportReceipt: string | null = null): Promise<LaunchResponse> {
    return this.locked(async () => {
      const occurred_at = this.now();
      const prov = this.prov('wrapper', transportReceipt);

      // SCHEMA-level invariant (the instances.tmux_pane lesson): pin exact version.
      if (req.schema_version !== SCHEMA_VERSION) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`, binding_generation: null,
        };
      }

      // Reg-audit: every attestation-defined-so-far must be present.
      const missing = REQUIRED_REGISTRATION_FIELDS.filter((a) => req[a] === undefined || req[a] === null || req[a] === '');
      if (missing.length > 0) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [...missing],
          reason: `reg-audit refused handover: missing ${missing.join(', ')}`, binding_generation: null,
        };
      }

      // Binding integrity is checked against one projection snapshot while the
      // single-writer lock is held. No implicit handover: callers must close a
      // current binding before a different launch can claim either side.
      const proj = await this.projections();
      const seatBinding = proj.currentBindings.find((binding) => binding.seat_id === req.seat_id);
      if (seatBinding) {
        const exactRepeat = seatBinding.instance_id === req.instance_id
          && seatBinding.wrapper_id === req.wrapper_id && seatBinding.engine === req.engine
          && seatBinding.persona === req.persona_id && seatBinding.rank === req.rank
          && seatBinding.commander_type === req.commander_type && seatBinding.commander_id === req.commander_id
          && seatBinding.singleton_authority === req.singleton_authority
          && seatBinding.dispatch_authority === req.dispatch_authority
          && seatBinding.session_doc_id === req.session_doc_id && seatBinding.device_id === req.device_id
          && seatBinding.working_dir === req.working_dir && seatBinding.origin_type === req.origin_type
          && seatBinding.execution_placement === req.execution_placement;
        if (exactRepeat) {
          return { ok: true, seat_id: req.seat_id, handover: true, missing_attestations: [], reason: null, binding_generation: seatBinding.bound_seq };
        }
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `seat_occupied: ${req.seat_id} already has a current binding`, binding_generation: null,
        };
      }
      const instanceBinding = proj.currentBindings.find((binding) => binding.instance_id === req.instance_id || binding.wrapper_id === req.wrapper_id);
      if (instanceBinding) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `instance_already_bound: instance or wrapper already has a current seat binding`, binding_generation: null,
        };
      }
      if (proj.activityByInstance.get(req.instance_id) === 'retired') {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: 'instance_retired: retired identities cannot be rebound', binding_generation: null,
        };
      }

      // The estate is persistent. A launch may bind an already-made canonical
      // seat. Only a new seat gets a pane_created fact; createSeat guarantees its
      // canonical tag or compensates the new session before throwing.
      const existingSeat = (await this.tmux.listSeats()).some((seat) => seat.seat_id === req.seat_id);
      if (!existingSeat) {
        await this.tmux.createSeat(req.seat_id);
        const created = (await this.tmux.listSeats()).filter((seat) => seat.seat_id === req.seat_id && seat.pane === 'live');
        if (created.length !== 1) {
          await this.tmux.killSeat(req.seat_id);
          throw new Error(`txd launch canonical seat postcondition failed for ${req.seat_id}`);
        }
        await this.store.append({
          entity_type: 'seat',
          entity_id: req.seat_id,
          event_type: 'reg.pane_created',
          payload: { pane_state: 'live' },
          provenance: prov,
          occurred_at,
        });
      }

      let wrapperStarted = false;
      let sessionStarted = false;
      try {
        await this.launchChain.startWrapper(req); wrapperStarted = true;
        await this.launchChain.startEngineSession(req); sessionStarted = true;
        const common = { ...req } as Record<string, unknown>;
        delete common.schema_version; delete common.seat_id;
        const written = await this.store.appendAll([
          { entity_type: 'instance', entity_id: req.instance_id, event_type: 'reg.dispatch_requested', payload: { seat_id: req.seat_id, dispatch_authority: req.dispatch_authority }, provenance: prov, occurred_at },
          { entity_type: 'seat', entity_id: req.seat_id, event_type: 'reg.pane_observed', payload: { pane_state: 'live' }, provenance: this.prov('observer', transportReceipt), occurred_at },
          { entity_type: 'wrapper', entity_id: req.wrapper_id, event_type: 'reg.wrapper_started', payload: { instance_id: req.instance_id }, provenance: prov, occurred_at },
          { entity_type: 'instance', entity_id: req.instance_id, event_type: 'reg.session_started', payload: { wrapper_id: req.wrapper_id, engine: req.engine }, provenance: prov, occurred_at },
          { entity_type: 'seat', entity_id: req.seat_id, event_type: 'reg.bound', payload: common, provenance: prov, occurred_at },
        ]);
        const generation = written.at(-1)!.seq;
        await this.store.appendAll([
          { entity_type: 'instance', entity_id: req.instance_id, event_type: 'reg.readiness_attested', payload: { binding_generation: generation, execution_placement: req.execution_placement }, provenance: prov, occurred_at },
          { entity_type: 'instance', entity_id: req.instance_id, event_type: 'reg.route_activated', payload: { binding_generation: generation }, provenance: prov, occurred_at },
        ]);
        return { ok: true, seat_id: req.seat_id, handover: true, missing_attestations: [], reason: null, binding_generation: generation };
      } catch (error) {
        if (sessionStarted) await this.launchChain.stopEngineSession(req).catch(() => undefined);
        if (wrapperStarted) await this.launchChain.stopWrapper(req).catch(() => undefined);
        return { ok: false, seat_id: req.seat_id, handover: false, missing_attestations: [], reason: `launch_chain_failed: ${String(error)}`, binding_generation: null };
      }
    });
  }

  // ── constructEstate — boot-time idempotent ensure (estate, rung 2) ──────
  // Stands the canonical persistent estate (src/estate.ts) declaratively. NOT an
  // endpoint or CLI — the seed vocab/endpoint set is closed; this is a boot
  // ensure. Runs under the single-writer mutex so it can't interleave with a
  // concurrent launch/send. Idempotent: a re-run over a fully-present-and-attested
  // estate creates nothing and appends zero events. Each fresh seat records ONE
  // bare `reg.pane_created` (unbound) — it lands in freelist + activity_board and
  // triggers NO contradiction (reconcile only flags bound-dead / retired-live).
  //
  // Buckets: `created` = canonical pane made + event written this run;
  // `backfilled` = canonical pane already there but its event was missing;
  // `existing` = present AND attested. `failed` remains in the response contract
  // but shape failures throw before any event append: half-estates are refused.
  constructEstate(): Promise<{ created: string[]; existing: string[]; backfilled: string[]; failed: string[] }> {
    return this.locked(async () => {
      // Construction is all-or-nothing below the membrane: create on an empty
      // socket, accept the exact canonical shape, refuse every other estate.
      const estate = await this.tmux.ensureEstate();
      // Seats that already carry a `reg.pane_created` fact. A prior boot could
      // have torn (createSeat committed, its append did not) — the pane persists
      // but the fact was lost. Presence WITHOUT attestation is that torn state.
      const attested = new Set(
        (await this.store.readAll()).filter((e) => e.event_type === 'reg.pane_created').map((e) => e.entity_id),
      );
      const created: string[] = [];
      const existing: string[] = [];
      const backfilled: string[] = [];
      const failed: string[] = [];

      const recordCreated = async (seat: string): Promise<void> => {
        await this.store.append({
          entity_type: 'seat',
          entity_id: seat,
          event_type: 'reg.pane_created',
          payload: { pane_state: 'live' },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
      };

      for (const seat of TXD_ESTATE) {
        if (attested.has(seat)) {
          existing.push(seat);
          continue;
        }
        await recordCreated(seat);
        (estate === 'created' ? created : backfilled).push(seat);
      }

      return { created, existing, backfilled, failed };
    });
  }

  // ── /agents/send — the ONE chokepoint (spec §5) ───────────────────────────────────
  // enqueue-by-default; unresolved targets REFUSED at admission (never gated —
  // the #699 class is unrepresentable); typed gate true-cause; the receipt
  // carries the SAME resolution the send used (never re-derived).
  send(req: SendRequest, transportReceipt: string | null = null): Promise<SendReceipt | SendRefusal> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return this.refuse('schema_version_mismatch', req.target);
      }

      // Resolve target -> canonical seat + the seq it resolved against. Prefer a
      // current binding; fall back to a bare live seat.
      const proj = await this.projections();
      const resolution = this.resolveTarget(req.target, proj);
      if (!resolution) return this.refuse('pane_unresolved', req.target);
      // Pane must be live at admission (unresolved/dead never admitted).
      const board = proj.activityBoard.find((r) => r.seat_id === resolution.seat_id);
      if (board && board.pane === 'dead') return this.refuse('pane_dead', req.target);
      if (!board || board.registration !== 'registered') return this.refuse('unregistered', req.target);
      if (board.activity === 'stopped') return this.refuse('instance_stopped', req.target);
      if (board.activity === 'retired') return this.refuse('instance_retired', req.target);
      if (!board.placement) return this.refuse('placement_unattested', req.target);
      if (board.readiness !== 'ready') return this.refuse('unready', req.target);
      if (board.routing !== 'active') return this.refuse('route_inactive', req.target);
      if (proj.openContradictions.some((c) => c.entity_id === resolution.seat_id || c.entity_id === board.entity_id)) {
        return this.refuse('target_contradicted', req.target);
      }

      const occurred_at = this.now();
      const sendId = crypto.randomUUID();

      // Admit: enqueue with the resolution frozen into the queue item.
      await this.store.append({
        entity_type: 'send',
        entity_id: sendId,
        event_type: 'act.send_enqueued',
        payload: { target: resolution.seat_id, resolved_seq: resolution.bound_seq, text_len: req.text.length },
        provenance: this.prov('wrapper', transportReceipt),
        occurred_at,
      });

      // Typed-cause gate. Presence is a point-in-time READ of server-maintained
      // client_activity — no shadow state, no keystroke hook. Emitting the gate
      // records the DECISION (carrying its window evidence); raw presence never
      // enters the stream. A gated send STAYS enqueued for a later drain.
      const gate = async (): Promise<SendReceipt> => {
        await this.store.append({
          entity_type: 'send',
          entity_id: sendId,
          event_type: 'act.send_gated',
          payload: {
            target: resolution.seat_id,
            reason: 'typing_guard',
            activity_window_ms: SEND_PRESENCE_ACTIVITY_WINDOW_MS,
            resolved_seq: resolution.bound_seq,
          },
          provenance: this.prov('observer', transportReceipt),
          occurred_at: this.now(),
        });
        this.schedule(
          () => this.releaseGuardedSend(sendId, resolution, req.text, transportReceipt),
          SEND_PRESENCE_ACTIVITY_WINDOW_MS,
        );
        return this.receipt('enqueued_gated', resolution, sendId, 'typing_guard', SEND_PRESENCE_ACTIVITY_WINDOW_MS, null);
      };

      // A current binding is the ledger's positive proof that this pane is an
      // agent seat. Agent output is never operator composition territory, so
      // daemon-to-agent delivery bypasses the client-activity guard entirely.
      if (resolution.bound_seq > 0) {
        return this.deliverSend(sendId, resolution, req.text, transportReceipt, 'agent_seat_exempt');
      }

      // Presence read at ADMISSION (the enqueue-time snapshot, spec §5 rung 4):
      // operator active ⇒ defer this pass (gate now, deliver on a later drain).
      const presentAtAdmission = await this.tmux.presentSeats(SEND_PRESENCE_ACTIVITY_WINDOW_MS, this.nowMs());
      if (presentAtAdmission.has(resolution.seat_id)) return gate();

      // Presence read at DRAIN (the delivery instant): re-read fresh — the
      // operator may have become active between admission and drain.
      const presentAtDrain = await this.tmux.presentSeats(SEND_PRESENCE_ACTIVITY_WINDOW_MS, this.nowMs());
      if (presentAtDrain.has(resolution.seat_id)) return gate();

      // Operator idle at BOTH decision points → deliver (canonical in, %id internal).
      return this.deliverSend(sendId, resolution, req.text, transportReceipt, 'operator_idle');
    });
  }

  private releaseGuardedSend(
    sendId: string,
    resolution: SendResolution,
    text: string,
    transportReceipt: string | null,
  ): Promise<void> {
    return this.locked(async () => {
      const present = await this.tmux.presentSeats(SEND_PRESENCE_ACTIVITY_WINDOW_MS, this.nowMs());
      if (present.has(resolution.seat_id)) {
        this.schedule(
          () => this.releaseGuardedSend(sendId, resolution, text, transportReceipt),
          SEND_PRESENCE_ACTIVITY_WINDOW_MS,
        );
        return;
      }
      await this.deliverSend(sendId, resolution, text, transportReceipt, 'typing_guard_expired');
    });
  }

  private async deliverSend(
    sendId: string,
    resolution: SendResolution,
    text: string,
    transportReceipt: string | null,
    releaseReason: 'agent_seat_exempt' | 'operator_idle' | 'typing_guard_expired',
  ): Promise<SendReceipt> {
    // Frozen-generation guard remains the final check immediately before the
    // side effect. Readiness is necessary, never a substitute for this guard.
    const current = await this.projections();
    const binding = current.currentBindings.find((b) => b.seat_id === resolution.seat_id);
    if (!binding || binding.bound_seq !== resolution.bound_seq || binding.readiness !== 'ready' || binding.routing !== 'active'
      || current.openContradictions.some((c) => c.entity_id === resolution.seat_id || c.entity_id === binding.instance_id)) {
      return this.receipt('failed_none_delivered', resolution, sendId, null, null, 0);
    }
    const result = await this.tmux.sendToSeat(resolution.seat_id, text);
    for (const observation of result.trace ?? []) {
      await this.store.append({
        entity_type: 'send',
        entity_id: sendId,
        event_type: 'act.send_submit_observed',
        payload: { target: resolution.seat_id, ...observation, resolved_seq: resolution.bound_seq },
        provenance: this.prov('observer', transportReceipt),
        occurred_at: this.now(),
      });
    }
    const verdict: DeliveryVerdict = result.verdict;
    if (verdict === 'delivered') {
      await this.store.append({
        entity_type: 'send',
        entity_id: sendId,
        event_type: 'act.send_delivered',
        payload: {
          target: resolution.seat_id,
          bytes: result.bytes,
          resolved_seq: resolution.bound_seq,
          release_reason: releaseReason,
        },
        provenance: this.prov('observer', transportReceipt),
        occurred_at: this.now(),
      });
    }
    // partial_delivered = text inserted but not submitted → stays enqueued (like a
    // gate); the receipt still carries the partial verdict + its byte evidence
    // (contract requires non-null bytes for partial). Only a full delivery dequeues.
    return this.receipt(verdict, resolution, sendId, null, null, verdict === 'failed_none_delivered' ? 0 : result.bytes);
  }

  private resolveTarget(target: string, proj: Projections): SendResolution | null {
    // A bound seat, matched by seat id or by the instance it carries.
    const binding = proj.currentBindings.find((b) => b.seat_id === target || b.instance_id === target);
    if (binding) return { target, seat_id: binding.seat_id, bound_seq: binding.bound_seq };
    // A bare live seat (no binding) — resolves against the seat's board row.
    // The predicate matched seat_id === target, so the seat id IS target here.
    const bare = proj.activityBoard.find((r) => r.seat_id === target && r.binding === 'unbound' && r.pane !== 'dead');
    if (bare) return { target, seat_id: target, bound_seq: 0 };
    return null;
  }

  private refuse(reason: SendRefusalReason, target: string): SendRefusal {
    // The membrane also covers logs: a client may hand us a raw `%5`; redact it
    // in the log line while returning the caller's original target unchanged.
    const loggedTarget = findTmuxId(target) ? '<redacted-tmux-id>' : target;
    console.error(JSON.stringify({ level: 'error', event: 'send_refused', reason, target: loggedTarget }));
    return { ok: false, refused: true, reason, target };
  }

  private async receipt(
    verdict: DeliveryVerdict,
    resolution: SendResolution,
    sendId: string,
    gate: 'typing_guard' | null,
    window: number | null,
    bytes: number | null,
  ): Promise<SendReceipt> {
    return {
      verdict,
      resolution,
      gate_reason: gate,
      activity_window_ms: window,
      bytes_delivered: bytes,
      send_seq: (await this.store.readByEntity(sendId)).at(-1)?.seq ?? -1,
    };
  }

  readiness(req: ReadinessRequest, transportReceipt: string | null = null): Promise<AxisResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) return { ok: false, instance_id: req.instance_id, binding_generation: null, reason: 'schema_version_mismatch' };
      const proj = await this.projections();
      const binding = proj.currentBindings.find((b) => b.instance_id === req.instance_id);
      if (!binding) return { ok: false, instance_id: req.instance_id, binding_generation: null, reason: 'unregistered' };
      if (binding.bound_seq !== req.binding_generation) return { ok: false, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: 'stale_binding' };
      if (!binding.placement || binding.execution_placement !== req.execution_placement) return { ok: false, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: 'placement_unattested' };
      if (proj.openContradictions.some((c) => c.entity_id === binding.seat_id || c.entity_id === req.instance_id)) return { ok: false, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: 'target_contradicted' };
      if (binding.readiness !== 'ready') await this.store.append({ entity_type: 'instance', entity_id: req.instance_id, event_type: 'reg.readiness_attested', payload: { binding_generation: binding.bound_seq, execution_placement: req.execution_placement }, provenance: this.prov('wrapper', transportReceipt), occurred_at: this.now() });
      return { ok: true, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: null };
    });
  }

  activateRoute(req: RouteRequest, transportReceipt: string | null = null): Promise<AxisResponse> {
    return this.routeTransition(req, 'reg.route_activated', transportReceipt);
  }
  suspendRoute(req: RouteRequest, transportReceipt: string | null = null): Promise<AxisResponse> {
    return this.routeTransition(req, 'reg.route_suspended', transportReceipt);
  }
  retireRoute(req: RouteRequest, transportReceipt: string | null = null): Promise<AxisResponse> {
    return this.routeTransition(req, 'reg.route_retired', transportReceipt);
  }
  private routeTransition(req: RouteRequest, event_type: 'reg.route_activated' | 'reg.route_suspended' | 'reg.route_retired', transportReceipt: string | null): Promise<AxisResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) return { ok: false, instance_id: req.instance_id, binding_generation: null, reason: 'schema_version_mismatch' };
      const proj = await this.projections();
      const binding = proj.currentBindings.find((b) => b.instance_id === req.instance_id);
      if (!binding) return { ok: false, instance_id: req.instance_id, binding_generation: null, reason: 'unregistered' };
      if (binding.bound_seq !== req.binding_generation) return { ok: false, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: 'stale_binding' };
      if (event_type === 'reg.route_activated' && binding.readiness !== 'ready') return { ok: false, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: 'unready' };
      await this.store.append({ entity_type: 'instance', entity_id: req.instance_id, event_type, payload: { binding_generation: binding.bound_seq, reason: req.reason ?? null }, provenance: this.prov('wrapper', transportReceipt), occurred_at: this.now() });
      return { ok: true, instance_id: req.instance_id, binding_generation: binding.bound_seq, reason: null };
    });
  }

  // ── /agents/close — the generic "close this instance" system (rung 3) ──────────────
  // Reaps the agent process and returns the estate seat to the freelist. Terminal
  // chain (retired + process_reaped + seat_cleared) is atomic and only written
  // AFTER the process is confirmed reaped — a retire-with-live-process is
  // unspellable (spec §4). No silent no-op: an unbound target or a failed reap
  // refuses loud and changes nothing (the mac mark-for-close-noop class, killed).
  close(req: CloseRequest, transportReceipt: string | null = null): Promise<CloseResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return {
          ok: false,
          target: req.target,
          seat_id: null,
          instance_id: null,
          closed: false,
          reason: `schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`,
        };
      }

      const proj = await this.projections();
      const binding = proj.currentBindings.find((b) => b.seat_id === req.target || b.instance_id === req.target);
      if (!binding) {
        // Refuse loud — closing a non-bound target is a no-op the caller must see,
        // never a silent success (the mac /mark-for-close returned ok on nothing).
        return {
          ok: false,
          target: req.target,
          seat_id: null,
          instance_id: null,
          closed: false,
          reason: 'no_binding: target resolves to no current binding (already free or never bound)',
        };
      }

      // Reap FIRST; attest only on a confirmed kill (executeClose is the SAME path
      // the reflexive auto-close fires — one close mechanism, no bespoke variant).
      const closed = await this.executeClose(binding, transportReceipt);
      if (!closed) {
        return {
          ok: false,
          target: req.target,
          seat_id: binding.seat_id,
          instance_id: binding.instance_id,
          closed: false,
          reason: 'reap_failed: agent process could not be reaped; seat left bound (fail-loud, no half-close)',
        };
      }
      return { ok: true, target: req.target, seat_id: binding.seat_id, instance_id: binding.instance_id, closed: true, reason: null };
    });
  }

  // The generic close mechanism, shared by /agents/close and the reflexive auto-close.
  // Reap-first, attest-after: respawn-pane -k keeps the estate pane (bare shell)
  // so the seat survives and returns to the freelist. On a confirmed reap, ONE
  // transaction writes retired + process_reaped + seat_cleared (seat_cleared frees
  // the binding — the ledger PROJECTION follows, no separate ledger to leak).
  // Returns false (nothing written) if the process could not be reaped, so a
  // retire-with-live-process is unspellable. Caller holds the single-writer mutex.
  private async executeClose(binding: CurrentBinding, transportReceipt: string | null): Promise<boolean> {
    const reaped = await this.tmux.reapSeat(binding.seat_id);
    if (!reaped) return false;
    const occurred_at = this.now();
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.instance_id) {
      inputs.push({ entity_type: 'instance', entity_id: binding.instance_id, event_type: 'reg.route_retired', payload: { binding_generation: binding.bound_seq, reason: 'instance_retired' }, provenance: prov, occurred_at });
      inputs.push({ entity_type: 'instance', entity_id: binding.instance_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    }
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { instance_id: binding.instance_id }, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_cleared', payload: {}, provenance: prov, occurred_at });
    await this.store.appendAll(inputs);
    return true;
  }

  // ── /agents/subscribe — the generic stop-hook subscription system (rung 3) ─────────
  // Records a close-on-next-stop subscription. BOUND-KEYED: refuses unless the
  // instance is currently bound, so an orphan/never-bound id can never hold a
  // subscription (the 77f7cfb4 re-firing class is structurally dead). Composing
  // this with /ingress/hooks/stop yields `final message → auto-close on next stop-hook`.
  subscribe(req: SubscribeRequest, transportReceipt: string | null = null): Promise<SubscribeResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return {
          ok: false,
          instance_id: req.instance_id,
          action: null,
          subscribed: false,
          reason: `schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`,
        };
      }
      const proj = await this.projections();
      if (!proj.currentBindings.some((b) => b.instance_id === req.instance_id)) {
        return {
          ok: false,
          instance_id: req.instance_id,
          action: null,
          subscribed: false,
          reason: 'not_bound: subscriptions are bound-keyed — an unbound/never-bound instance cannot subscribe',
        };
      }
      await this.store.append({
        entity_type: 'instance',
        entity_id: req.instance_id,
        event_type: 'reg.stop_subscribed',
        payload: { action: req.action },
        provenance: this.prov('wrapper', transportReceipt),
        occurred_at: this.now(),
      });
      return { ok: true, instance_id: req.instance_id, action: req.action, subscribed: true, reason: null };
    });
  }

  // ── /ingress/hooks/stop — the stop-hook's door (rung 3) ───────────────────────────────────
  // Three honest outcomes, no blind swallow: record a fresh stop (bound + live),
  // dedupe a repeat/late stop (act.receipt_deduped), or REFUSE a ghost — a stop for
  // an id that never walked through /agents/launch. The ghost is refused at admission, so
  // nothing is recorded: no phantom row, no re-firing subscription (the 77f7cfb4
  // class is structurally dead). The stop-hook is a REAL but UNTRUSTED witness.
  stop(req: StopRequest, transportReceipt: string | null = null): Promise<StopReceipt | StopRefusal> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return this.refuseStop('schema_version_mismatch', req.instance_id);
      }

      const proj = await this.projections();
      // Ghost preclusion: never bound ⇒ never existed ⇒ refuse loud.
      if (!proj.everBoundInstances.has(req.instance_id)) {
        return this.refuseStop('no_such_instance', req.instance_id);
      }

      const activity = proj.activityByInstance.get(req.instance_id) ?? null;
      const stillBound = proj.currentBindings.some((b) => b.instance_id === req.instance_id);
      // Dedupe: already stopped/retired, or already closed (no longer bound) →
      // idempotent, but RECORDED as receipt_deduped (never a blind swallow).
      if (activity === 'stopped' || activity === 'retired' || !stillBound) {
        await this.store.append({
          entity_type: 'instance',
          entity_id: req.instance_id,
          event_type: 'act.receipt_deduped',
          payload: { of: 'stop_reported', reason: activity ?? 'unbound' },
          provenance: this.prov('observer', transportReceipt),
          occurred_at: this.now(),
        });
        return { ok: true, instance_id: req.instance_id, recorded: false, deduped: true, activity, auto_close: 'none' };
      }

      // Fresh stop for a live, bound instance → record it (activity → stopped).
      await this.store.append({
        entity_type: 'instance',
        entity_id: req.instance_id,
        event_type: 'act.stop_reported',
        payload: {},
        provenance: this.prov('hook', transportReceipt),
        occurred_at: this.now(),
      });

      // Reflexive auto-close: an OPEN close-on-stop subscription fires now (the stop
      // we just recorded satiates it). `proj` is the pre-stop read, so the binding
      // is still present; executeClose is the SAME mechanism as /agents/close.
      let auto_close: StopAutoCloseOutcome = 'none';
      if (proj.openStopSubscriptions.has(req.instance_id)) {
        const binding = proj.currentBindings.find((b) => b.instance_id === req.instance_id);
        if (binding) {
          const closed = await this.executeClose(binding, transportReceipt);
          auto_close = closed ? 'fired' : 'reap_failed';
          if (!closed) {
            // Loud, not silent: the instance stays stopped+bound (visible), never a
            // quiet leak. Reconcile catches any lingering retire-with-live-process.
            console.error(
              JSON.stringify({ level: 'error', event: 'auto_close_reap_failed', instance_id: req.instance_id, seat_id: binding.seat_id }),
            );
          }
        }
      }
      return { ok: true, instance_id: req.instance_id, recorded: true, deduped: false, activity: 'stopped', auto_close };
    });
  }

  private refuseStop(reason: StopRefusalReason, instanceId: string): StopRefusal {
    const logged = findTmuxId(instanceId) ? '<redacted-tmux-id>' : instanceId;
    console.error(JSON.stringify({ level: 'error', event: 'stop_refused', reason, instance_id: logged }));
    return { ok: false, refused: true, reason, instance_id: instanceId };
  }

  // ── /ctl/reconcile — replay + contradiction observation (spec §6) ───────────────
  // Pure replay rebuild; observes tmux and emits contradiction_flagged for
  // discrepancies (NEVER a synthesized lifecycle event). Bring-up mode: every
  // open contradiction is p0 — fail loud, ok=false.
  reconcile(transportReceipt: string | null = null): Promise<ReconcileResponse> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const t0 = performance.now();
      const proj = buildProjections(events);
      const replay_ms = performance.now() - t0;

      const observed = await this.tmux.listSeats();
      const observedPane = new Map(observed.map((o) => [o.seat_id, o.pane]));
      const projectedSeats = new Set(proj.activityBoard.map((row) => row.seat_id).filter((seat): seat is string => seat !== null));

      // Observation is its own fact. Absence never masquerades as teardown.
      const observationInputs: EventInput[] = [];
      for (const seat of projectedSeats) observationInputs.push({
        entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_observed',
        payload: { pane_state: observedPane.get(seat) ?? 'absent' }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
      });
      for (const [seat, pane] of observedPane) if (!projectedSeats.has(seat)) observationInputs.push({
        entity_type: 'seat', entity_id: seat, event_type: 'reg.pane_observed', payload: { pane_state: pane },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
      });
      if (observationInputs.length) await this.store.appendAll(observationInputs);

      const alreadyOpen = new Map(proj.openContradictions.map((c) => [`${c.entity_id}:${c.kind}`, c]));
      const newContradictions: OpenContradiction[] = [];
      const presentProblems = new Set<string>();

      const flag = async (
        entity_id: string,
        kind: string,
        missing: string | null,
        detail: string,
      ): Promise<void> => {
        presentProblems.add(`${entity_id}:${kind}`);
        if (alreadyOpen.has(`${entity_id}:${kind}`)) return;
        const occurred_at = this.now();
        const rec = await this.store.append({
          entity_type: 'seat',
          entity_id,
          event_type: 'reg.contradiction_flagged',
          payload: { kind, missing_attestation: missing, detail },
          provenance: this.prov('observer', transportReceipt),
          occurred_at,
        });
        console.error(
          JSON.stringify({ level: 'error', event: 'contradiction_flagged', p0: true, entity_id, kind, missing_attestation: missing, detail }),
        );
        newContradictions.push({
          seq: rec.seq,
          entity_type: 'seat',
          entity_id,
          kind,
          missing_attestation: missing,
          detail,
          occurred_at,
        });
      };

      for (const row of proj.activityBoard) {
        const pane = observedPane.get(row.seat_id!);
        if (pane === undefined) await flag(row.seat_id!, row.binding === 'bound' ? 'absent_bound_seat' : 'absent_unbound_projected_seat', 'pane_presence', 'projected seat is physically absent');
        else if (pane === 'dead' && row.binding === 'bound') await flag(row.seat_id!, 'bound_pane_dead', 'seat_cleared', `seat is bound but tmux pane is dead`);
      }
      for (const seat of observedPane.keys()) {
        if (!projectedSeats.has(seat)) await flag(seat, 'physical_seat_missing_projection', 'projection_evidence', 'physical seat has no prior projection evidence');
      }
      // Retired instance whose pane is still live (retire-with-live-process).
      for (const row of proj.activityBoard) {
        if (row.seat_id === null) continue; // board row without a seat can't be a seat-liveness contradiction
        if (row.activity === 'retired' && observedPane.get(row.seat_id) === 'live') {
          await flag(row.seat_id, 'retired_pane_live', 'process_reaped', `activity=retired but tmux pane is live`);
        }
      }

      // Contradictions close only through an explicit, sequence-and-kind keyed
      // resolution fact after the new physical observation disproves them.
      const resolutions: EventInput[] = [];
      for (const [key, contradiction] of alreadyOpen) if (!presentProblems.has(key)) resolutions.push({
        entity_type: contradiction.entity_type, entity_id: contradiction.entity_id, event_type: 'reg.contradiction_resolved',
        payload: { contradiction_seq: contradiction.seq, kind: contradiction.kind }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
      });
      if (resolutions.length) await this.store.appendAll(resolutions);

      // Recompute open set over the freshly-appended stream.
      const openContradictions = buildProjections(await this.store.readAll()).openContradictions;
      const p0 = openContradictions.length > 0;

      return {
        ok: !p0,
        replayed_events: events.length,
        replay_ms,
        bindings: proj.currentBindings.length,
        freelist: proj.freelist.length,
        instances: proj.activityBoard.length,
        new_contradictions: newContradictions,
        open_contradictions: openContradictions,
        p0,
      };
    });
  }

  // ── Read model (spec §7 rung 6, reshaped [[txd-extraction-spec]] §6) ────────
  // The estate observation view behind `GET /tmux/read/estate` — txd's ONLY
  // public read surface. Per-entity event history is NOT served publicly:
  // the stream stays private replay/reconcile truth (biography serving is not
  // txd's job).
  async estateRows(): Promise<ActivityBoardRow[]> {
    return (await this.projections()).activityBoard;
  }

  async health(machine: string, build: { version: string; git_sha: string; bun: string }): Promise<Health> {
    const proj = await this.projections();
    // Probe the daemon's OWN tmux socket (start-server + list-panes), not just
    // `tmux -V` — a responding binary over a dead socket must not read healthy.
    const tmux_reachable = await this.tmux.reachable();
    const open = proj.openContradictions.length;
    const observed = await this.tmux.listSeats();
    const projected = new Map(proj.activityBoard.map((row) => [row.seat_id, row.pane]));
    const canonicalPhysical = observed.length === TXD_ESTATE.length && TXD_ESTATE.every((seat) => observed.some((row) => row.seat_id === seat));
    const physicalMismatch = !canonicalPhysical || observed.length !== projected.size || observed.some((seat) => {
      const pane = projected.get(seat.seat_id);
      return pane === undefined || (pane === 'empty' ? 'live' : pane) !== seat.pane;
    });
    return {
      ok: open === 0 && tmux_reachable && !physicalMismatch,
      service: 'txd' as const,
      schema_version: SCHEMA_VERSION,
      version: build.version,
      git_sha: build.git_sha,
      bun: build.bun,
      machine,
      events: await this.store.count(),
      open_contradictions: open,
      tmux_reachable,
    };
  }
}

export type { EventInput };
