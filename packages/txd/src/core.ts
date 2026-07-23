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
  type CommAccepted,
  type CommCallback,
  type CommHook,
  type CommRequest,
  type CommTarget,
  type CommWaitRequest,
  type CommWaitResponse,
  type CurrentBinding,
  type DeliveryVerdict,
  type EventInput,
  type Health,
  type EstateRotateRequest,
  type EstateRotateResponse,
  type LaunchRequest,
  type LaunchResponse,
  type OpenContradiction,
  type Provenance,
  type ProvenanceSource,
  type ReconcileResponse,
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
import { NOOP_ROTATION_BARRIER, type EstateRotationBarrier } from './rotation-lock.ts';
import type { TmuxControlPlane } from './tmux.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const DOOR1_REQUIRED_ATTESTATIONS = ['identity', 'persona', 'tint'] as const;

type Now = () => string;
type ScheduledCallback = () => void | Promise<void>;
type Schedule = (callback: ScheduledCallback, delayMs: number) => void;

const scheduleGuardRelease: Schedule = (callback, delayMs) => {
  const timer = setTimeout(() => void callback(), delayMs);
  timer.unref?.();
};

export class Daemon {
  private mutex: Promise<unknown> = Promise.resolve();
  private commWaiters = new Map<string, Set<() => void>>();

  constructor(
    private store: EventStore,
    private tmux: TmuxControlPlane,
    private now: Now = () => new Date().toISOString(),
    private schedule: Schedule = scheduleGuardRelease,
    private nowMs: () => number = Date.now,
    private rotationBarrier: EstateRotationBarrier = NOOP_ROTATION_BARRIER,
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

  private wakeAsk(askId: string): void {
    for (const wake of this.commWaiters.get(askId) ?? []) wake();
    this.commWaiters.delete(askId);
  }

  private commTargets(identity: string, proj: Projections): CommTarget[] {
    const matches = proj.currentBindings.filter((b) =>
      b.instance_id === identity || b.persona === identity || b.seat_id === identity,
    );
    return matches.map((b) => ({ instance_id: b.instance_id!, seat_id: b.seat_id, persona: b.persona }));
  }

  comm(req: CommRequest, transportReceipt: string | null = null): Promise<CommAccepted> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      if (!proj.currentBindings.some((b) => b.instance_id === req.source_instance_id)) throw new Error('source_not_bound');
      const events = await this.store.readAll();
      let targetIdentity = req.target;
      let replyingToAsk: string | null = null;
      if (req.reply) {
        const inbound = [...events].reverse().find((e) => e.event_type === 'reg.comm_accepted'
          && Array.isArray(e.payload.target_instance_ids)
          && e.payload.target_instance_ids.includes(req.source_instance_id));
        if (!inbound) throw new Error('no_recent_inbound_sender');
        targetIdentity = String(inbound.payload.source_instance_id);
        replyingToAsk = typeof inbound.payload.ask_id === 'string' ? inbound.payload.ask_id : null;
      }
      let targets: CommTarget[];
      if (req.page) {
        targets = proj.currentBindings
          .filter((b) => b.seat_id.split(':', 1)[0] === req.page)
          .map((b) => ({ instance_id: b.instance_id!, seat_id: b.seat_id, persona: b.persona }));
        if (targets.length === 0) throw new Error(`page_absent: ${req.page}`);
      } else {
        targets = this.commTargets(targetIdentity!, proj);
        if (targets.length === 0) throw new Error(`identity_absent: ${targetIdentity}`);
        if (targets.length > 1) throw new Error(`identity_ambiguous: ${targetIdentity}`);
      }
      const messageId = crypto.randomUUID();
      const askId = req.ask ? crypto.randomUUID() : null;
      const occurred_at = this.now();
      const accepted = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted', payload: {
        source_instance_id: req.source_instance_id, target_instance_ids: targets.map((t) => t.instance_id), targets,
        ask_id: askId, reply_to_ask_id: replyingToAsk, message: req.message,
      }, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      const snapshot = await this.store.append({ entity_type: askId ? 'ask' : 'message', entity_id: askId ?? messageId,
        event_type: 'reg.comm_target_snapshotted', payload: { message_id: messageId, targets }, provenance: this.prov('observer', transportReceipt), occurred_at });
      const event_ids = [accepted.seq, snapshot.seq];
      for (const target of targets) {
        const frame = `[tx comm ${messageId} from ${req.source_instance_id}${askId ? ` ask ${askId}` : ''}]\n${req.message}`;
        const sent = await this.tmux.sendToSeat(target.seat_id, frame);
        if (sent.verdict !== 'delivered') throw new Error(`transport_${sent.verdict}: ${target.instance_id}`);
        const event = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
          payload: { target_instance_id: target.instance_id, seat_id: target.seat_id, bytes: sent.bytes }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
        event_ids.push(event.seq);
      }
      if (replyingToAsk) await this.assertCallback(replyingToAsk, req.source_instance_id, req.message, 'reply', null, transportReceipt);
      return { ok: true, message_id: messageId, ask_id: askId, source_instance_id: req.source_instance_id, targets, bytes_sent: true, event_ids };
    });
  }

  private async assertCallback(askId: string, targetInstance: string, content: string, source: 'reply' | 'stop', stopEventId: string | null, receipt: string | null): Promise<void> {
    const events = await this.store.readAll();
    const snapshot = events.find((e) => e.entity_id === askId && e.event_type === 'reg.comm_target_snapshotted');
    const targets = (snapshot?.payload.targets ?? []) as CommTarget[];
    if (!targets.some((t) => t.instance_id === targetInstance)) return;
    if (events.some((e) => e.event_type === 'act.comm_callback_asserted' && e.payload.ask_id === askId && e.payload.target_instance_id === targetInstance)) return;
    const accepted = events.find((e) => e.entity_id === snapshot?.payload.message_id && e.event_type === 'reg.comm_accepted');
    const subscriber = String(accepted?.payload.source_instance_id ?? '');
    const assertionId = source === 'stop' ? `${stopEventId ?? 'stop'}:${subscriber}:${targetInstance}` : `${askId}:${targetInstance}`;
    if (events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_callback_asserted')) return;
    await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_callback_asserted',
      payload: { ask_id: askId, subscriber_instance_id: subscriber, target_instance_id: targetInstance, content, source, stop_event_id: stopEventId }, provenance: this.prov('observer', receipt), occurred_at: this.now() });
    this.wakeAsk(askId);
  }

  promptSubmitted(hook: CommHook, receipt: string | null = null): Promise<{ ok: true; asserted: boolean }> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const accepted = events.find((e) => e.entity_id === hook.message_id && e.event_type === 'reg.comm_accepted');
      if (!accepted || !(accepted.payload.target_instance_ids as unknown[]).includes(hook.instance_id)) throw new Error('message_target_mismatch');
      const assertionId = `${hook.message_id}:${hook.instance_id}`;
      if (events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_delivery_asserted')) return { ok: true, asserted: false };
      await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
        payload: { message_id: hook.message_id, target_instance_id: hook.instance_id, source_instance_id: accepted.payload.source_instance_id }, provenance: this.prov('hook', receipt), occurred_at: this.now() });
      const proj = await this.projections();
      const sender = proj.currentBindings.find((b) => b.instance_id === accepted.payload.source_instance_id);
      if (sender) await this.tmux.sendToSeat(sender.seat_id, `[tx comm delivery confirmed ${hook.message_id} target ${hook.instance_id}]`);
      return { ok: true, asserted: true };
    });
  }

  commStop(instanceId: string, content: string, stopEventId: string | null, receipt: string | null): Promise<void> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const asks = events.filter((e) => e.event_type === 'reg.comm_target_snapshotted' && (e.payload.targets as CommTarget[]).some((t) => t.instance_id === instanceId));
      for (const ask of asks) await this.assertCallback(ask.entity_id, instanceId, content, 'stop', stopEventId, receipt);
    });
  }

  async waitComm(req: CommWaitRequest): Promise<CommWaitResponse> {
    if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
    const read = async (): Promise<CommWaitResponse> => {
      const events = await this.store.readAll();
      const snapshot = events.find((e) => e.entity_id === req.ask_id && e.event_type === 'reg.comm_target_snapshotted');
      if (!snapshot) throw new Error('ask_absent');
      const targets = snapshot.payload.targets as CommTarget[];
      const accepted = events.find((e) => e.entity_id === snapshot.payload.message_id && e.event_type === 'reg.comm_accepted');
      if (accepted?.payload.source_instance_id !== req.subscriber_instance_id) throw new Error('ask_subscriber_mismatch');
      const targetIds = new Set(targets.map((t) => t.instance_id));
      const callbacks: CommCallback[] = events.filter((e) => e.event_type === 'act.comm_callback_asserted' && (
        e.payload.ask_id === req.ask_id || (e.payload.source === 'stop' && e.payload.subscriber_instance_id === req.subscriber_instance_id && targetIds.has(String(e.payload.target_instance_id)))
      )).map((e) => ({
        target: targets.find((t) => t.instance_id === e.payload.target_instance_id)!, content: String(e.payload.content), assertion_event_id: e.seq, source: e.payload.source as 'reply' | 'stop',
      }));
      const done = new Set(callbacks.map((c) => c.target.instance_id));
      const outstanding = targets.filter((t) => !done.has(t.instance_id));
      return { ask_id: req.ask_id, complete: outstanding.length === 0, callbacks, outstanding };
    };
    const deadline = Date.now() + req.timeout_ms;
    let result = await read();
    while (!result.complete && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const set = this.commWaiters.get(req.ask_id) ?? new Set<() => void>(); set.add(resolve); this.commWaiters.set(req.ask_id, set);
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now())); timer.unref?.();
      });
      result = await read();
    }
    return result;
  }

  // ── /agents/launch — reg-audit SCAFFOLD (spec §4) ─────────────────────────────────
  // Refuses invalid or conflicting handovers before touching tmux. Binding is
  // ATOMIC: identity + persona + tint commit as ONE
  // `reg.bound` event carrying the full tuple — half-bound is unspellable.
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
          reason: `schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`,
        };
      }

      // Reg-audit: every attestation-defined-so-far must be present.
      const missing = DOOR1_REQUIRED_ATTESTATIONS.filter((a) => !req[a]);
      if (missing.length > 0) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [...missing],
          reason: `reg-audit refused handover: missing ${missing.join(', ')}`,
        };
      }

      // Binding integrity is checked against one projection snapshot while the
      // single-writer lock is held. No implicit handover: callers must close a
      // current binding before a different launch can claim either side.
      const proj = await this.projections();
      const seatBinding = proj.currentBindings.find((binding) => binding.seat_id === req.seat_id);
      if (seatBinding) {
        const exactRepeat = seatBinding.instance_id === req.identity
          && seatBinding.persona === req.persona
          && seatBinding.tint === req.tint
          && seatBinding.rank === (req.rank ?? null)
          && seatBinding.commander === (req.commander ?? null);
        if (exactRepeat) {
          return { ok: true, seat_id: req.seat_id, handover: true, missing_attestations: [], reason: null };
        }
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `seat_occupied: ${req.seat_id} already has a current binding`,
        };
      }
      const instanceBinding = proj.currentBindings.find((binding) => binding.instance_id === req.identity);
      if (instanceBinding) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `instance_already_bound: identity already has a current seat binding`,
        };
      }
      if (proj.activityByInstance.get(req.identity!) === 'retired') {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: 'instance_retired: retired identities cannot be rebound',
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

      // Atomic bind: the full tuple in ONE event.
      await this.store.append({
        entity_type: 'seat',
        entity_id: req.seat_id,
        event_type: 'reg.bound',
        payload: {
          wrapper_id: null,
          instance_id: req.identity,
          persona: req.persona,
          tint: req.tint,
          rank: req.rank ?? null,
          commander: req.commander ?? null,
        },
        provenance: prov,
        occurred_at,
      });

      return { ok: true, seat_id: req.seat_id, handover: true, missing_attestations: [], reason: null };
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
    // The admission resolution is a frozen generation, not permission to send
    // forever. Revalidate it at the last domain boundary before every tmux
    // delivery. The daemon lock makes this projection check and the following
    // adapter call one mutation-critical section for all sanctioned callers.
    if (!(await this.frozenResolutionIsCurrent(resolution))) {
      return this.cancelSend(sendId, resolution, transportReceipt);
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

  private async frozenResolutionIsCurrent(resolution: SendResolution): Promise<boolean> {
    const proj = await this.projections();
    const board = proj.activityBoard.find((row) => row.seat_id === resolution.seat_id);
    if (!board || board.pane === 'dead' || board.activity === 'retired') return false;

    const binding = proj.currentBindings.find((candidate) => candidate.seat_id === resolution.seat_id);
    if (resolution.bound_seq === 0) return binding === undefined && board.binding === 'unbound';
    return binding?.bound_seq === resolution.bound_seq && board.binding === 'bound';
  }

  private async cancelSend(
    sendId: string,
    resolution: SendResolution,
    transportReceipt: string | null,
  ): Promise<SendReceipt> {
    await this.store.append({
      entity_type: 'send',
      entity_id: sendId,
      event_type: 'act.send_cancelled',
      payload: {
        target: resolution.seat_id,
        resolved_seq: resolution.bound_seq,
        reason: 'binding_changed',
      },
      provenance: this.prov('observer', transportReceipt),
      occurred_at: this.now(),
    });
    return this.receipt('cancelled', resolution, sendId, null, null, 0);
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
      cancellation_reason: verdict === 'cancelled' ? 'binding_changed' : null,
      activity_window_ms: window,
      bytes_delivered: bytes,
      send_seq: (await this.store.readByEntity(sendId)).at(-1)?.seq ?? -1,
    };
  }

  // ── /agents/close — the generic "close this instance" system (rung 3) ──────────────
  // Reaps the agent process and returns the estate seat to the freelist. Terminal
  // chain (retired + process_reaped + seat_cleared) is atomic and only written
  // AFTER the process is confirmed reaped — a retire-with-live-process is
  // unspellable (spec §4). No silent no-op: an unbound target or a failed reap
  // refuses loud and changes nothing.
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
        // never a silent success.
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
  // this with the bus-delivered stop hook (/ingress/bus, hook.stop) yields
  // `final message → auto-close on next stop-hook`.
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

  // ── stop ingestion — the stop-hook's door (rung 3; delivered via /ingress/bus) ─────────────
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

      const alreadyOpen = new Set(proj.openContradictions.map((c) => `${c.entity_id}:${c.kind}`));
      const newContradictions: OpenContradiction[] = [];

      const flag = async (
        entity_id: string,
        kind: string,
        missing: string | null,
        detail: string,
      ): Promise<void> => {
        if (alreadyOpen.has(`${entity_id}:${kind}`)) return; // already flagged & still open
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

      // Bound seat whose pane died out-of-band (the retire chain never ran).
      for (const b of proj.currentBindings) {
        const pane = observedPane.get(b.seat_id);
        if (pane === 'dead' || pane === undefined) {
          await flag(
            b.seat_id,
            'bound_pane_dead',
            'seat_cleared',
            `seat is bound (bound_seq=${b.bound_seq}) but tmux pane is ${pane ?? 'absent'} — no teardown/reap/clear attested`,
          );
        }
      }
      // Retired instance whose pane is still live (retire-with-live-process).
      for (const row of proj.activityBoard) {
        if (row.seat_id === null) continue; // board row without a seat can't be a seat-liveness contradiction
        if (row.activity === 'retired' && observedPane.get(row.seat_id) === 'live') {
          await flag(row.seat_id, 'retired_pane_live', 'process_reaped', `activity=retired but tmux pane is live`);
        }
      }

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

  requestEstateRotation(req: EstateRotateRequest, transportReceipt: string | null = null): Promise<EstateRotateResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return { ok: false, rotation_id: null, accepted: false, force: req.force, bound_seats: [], foreground_workloads: [], reason: 'schema_version_mismatch' };
      }
      const proj = await this.projections();
      const bound_seats = proj.currentBindings.map((binding) => binding.seat_id).sort();
      const foreground_workloads = (await this.tmux.workloads())
        .filter((workload) => !workload.idle)
        .map(({ seat_id, command }) => ({ seat_id, command }))
        .sort((a, b) => a.seat_id.localeCompare(b.seat_id));
      const blocked = bound_seats.length > 0 || foreground_workloads.length > 0;
      const rotation_id = crypto.randomUUID();
      const occurred_at = this.now();
      const payload = { force: req.force, bound_seats, foreground_workloads };
      if (blocked && !req.force) {
        await this.store.append({ entity_type: 'estate', entity_id: rotation_id, event_type: 'estate.rotation_refused', payload, provenance: this.prov('wrapper', transportReceipt), occurred_at });
        return { ok: false, rotation_id, accepted: false, force: false, bound_seats, foreground_workloads, reason: 'estate_busy' };
      }
      await this.rotationBarrier.begin();
      try {
        await this.store.append({ entity_type: 'estate', entity_id: rotation_id, event_type: 'estate.rotation_requested', payload, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      } catch (error) {
        await this.rotationBarrier.abort();
        throw error;
      }
      return { ok: true, rotation_id, accepted: true, force: req.force, bound_seats, foreground_workloads, reason: null };
    });
  }

  async executeEstateRotation(): Promise<void> {
    if (!(await this.tmux.killServer())) {
      await this.rotationBarrier.abort();
      throw new Error('estate rotation failed to stop the owned tmux server');
    }
  }

  finalizeEstateRotation(): Promise<void> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const completed = new Set(events.filter((event) => event.event_type === 'estate.rotation_completed').map((event) => event.entity_id));
      const pending = [...events].reverse().find((event) => event.event_type === 'estate.rotation_requested' && !completed.has(event.entity_id));
      if (!pending) {
        await this.rotationBarrier.complete();
        return;
      }
      await this.store.append({
        entity_type: 'estate', entity_id: pending.entity_id, event_type: 'estate.rotation_completed',
        payload: { canonical_seats: TXD_ESTATE.length }, provenance: this.prov('observer', null), occurred_at: this.now(),
      });
      await this.rotationBarrier.complete();
    });
  }

  async health(machine: string, build: { version: string; git_sha: string; bun: string }): Promise<Health> {
    const proj = await this.projections();
    // Probe the externally supervised estate socket, not just `tmux -V` — a
    // responding binary over a dead socket must not read healthy.
    const tmux_reachable = await this.tmux.reachable();
    const open = proj.openContradictions.length;
    return {
      ok: open === 0, // bring-up mode: any open contradiction ⇒ not ok
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
