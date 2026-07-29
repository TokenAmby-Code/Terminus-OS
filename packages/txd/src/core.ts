// Daemon core — the domain logic behind the API (spec §4, §5, §6).
//
// Single writer: every mutating path runs under one async mutex so seq order
// and read-modify-write sequences never interleave. Truth is the event stream;
// this class only APPENDS facts and READS projections — it never mutates a
// projection directly.

import {
  SCHEMA_VERSION,
  type ActivityBoardRow,
  type CloseRequest,
  type CloseResponse,
  type ClipboardPullRequest,
  type ClipboardPushRequest,
  type ClipboardSelectionRequest,
  type CommAccepted,
  type CommCallback,
  type CommHook,
  type CommRequest,
  type CommTarget,
  type CommWaitRequest,
  type CommWaitResponse,
  type CurrentBinding,
  type EventInput,
  type Health,
  type EstateRotateRequest,
  type EstateRotateResponse,
  type LaunchRequest,
  type LaunchResponse,
  type ModeTransitionRequest,
  type ModeTransitionResponse,
  type OpenContradiction,
  type Provenance,
  type ProvenanceSource,
  type ReconcileResponse,
  type StopAutoCloseOutcome,
  type StopReceipt,
  type StopRefusal,
  type StopRefusalReason,
  type StopRequest,
  type StaticLaunchHandshake,
  type StaticLaunchHandshakeResponse,
  type SubscribeRequest,
  type SubscribeResponse,
  type TmuxLifecycleEventRequest,
  type TmuxLifecycleEventResponse,
  type TintReadiness,
  CLIPBOARD_BUFFER_NAME,
  MAX_CLIPBOARD_BYTES,
} from '@terminus-os/contracts';
import type { EventStore } from './store.ts';
import { findTmuxId } from './ids.ts';
import { buildProjections, type Projections } from './projections.ts';
import {
  DECOMMISSIONED_COUNCIL_SEATS,
  isTxdPage,
  STATIC_PERSONAS,
  TXD_ESTATE,
  TXD_WINDOWS,
} from './estate.ts';
import { NOOP_ROTATION_BARRIER, type EstateRotationBarrier } from './rotation-lock.ts';
import type { TmuxControlPlane } from './tmux.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const DOOR1_REQUIRED_ATTESTATIONS = ['identity', 'persona', 'tint'] as const;

type Now = () => string;
export type StaticLaunchRuntime = {
  agentWrapper: string;
  personaWorkspaceRoot: string;
  acknowledgeUrl: string;
};

const COUNCIL_MIGRATION_ID = 'council-static-personas';

export class Daemon {
  private mutex: Promise<unknown> = Promise.resolve();
  private commWaiters = new Map<string, Set<() => void>>();

  constructor(
    private store: EventStore,
    private tmux: TmuxControlPlane,
    private now: Now = () => new Date().toISOString(),
    private rotationBarrier: EstateRotationBarrier = NOOP_ROTATION_BARRIER,
    private staticRuntime: StaticLaunchRuntime | null = null,
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

  private pendingScopedResetSeats(events: Awaited<ReturnType<EventStore['readAll']>>): Set<string> {
    const closed = new Set(events
      .filter((event) =>
        event.event_type === 'estate.scoped_reset_completed'
        || event.event_type === 'estate.scoped_reset_failed',
      )
      .map((event) => event.entity_id));
    return new Set(events.flatMap((event) =>
      event.event_type === 'estate.scoped_reset_requested'
        && !closed.has(event.entity_id)
        && Array.isArray(event.payload.seats)
        ? event.payload.seats.filter((seat): seat is string => typeof seat === 'string')
        : [],
    ));
  }

  private async applyBindingTint(seatId: string, tint: string): Promise<boolean> {
    if (await this.tmux.setSeatTint(seatId, tint)) return true;
    if (!(await this.tmux.setSeatTint(seatId, null))) {
      throw new Error(`txd could not restore fail-dark tint state for ${seatId}`);
    }
    return false;
  }

  private async clearBindingTint(seatId: string): Promise<void> {
    if (!(await this.tmux.setSeatTint(seatId, null))) {
      throw new Error(`txd could not attest fail-dark tint state for ${seatId}`);
    }
  }

  private async prepareBinding(
    seatId: string,
    paneGeneration: string,
    tuple: Record<string, unknown>,
    provenance: Provenance,
    occurred_at: string,
  ): Promise<string> {
    const prepareId = crypto.randomUUID();
    await this.store.append({
      entity_type: 'seat',
      entity_id: seatId,
      event_type: 'reg.binding_prepared',
      payload: { prepare_id: prepareId, seat_id: seatId, pane_generation: paneGeneration, ...tuple },
      provenance,
      occurred_at,
    });
    return prepareId;
  }

  private async abortBinding(
    seatId: string,
    prepareId: string,
    reason: string,
    provenance: Provenance,
  ): Promise<void> {
    await this.store.append({
      entity_type: 'seat',
      entity_id: seatId,
      event_type: 'reg.binding_aborted',
      payload: { prepare_id: prepareId, reason },
      provenance,
      occurred_at: this.now(),
    });
  }

  private async compensateBindingCommitFailure(
    seatId: string,
    prepareId: string,
    provenance: Provenance,
    originalError: unknown,
  ): Promise<never> {
    const failedSteps: string[] = [];
    try {
      await this.clearBindingTint(seatId);
    } catch {
      failedSteps.push('tint_clear');
    }
    try {
      await this.abortBinding(seatId, prepareId, 'bound_commit_failed', provenance);
    } catch {
      failedSteps.push('binding_abort');
    }
    if (failedSteps.length > 0) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'binding_commit_compensation_failed',
        seat_id: seatId,
        failed_steps: failedSteps,
      }));
    }
    throw originalError;
  }

  /** Fail-dark recovery for a crash after physical style mutation but before reg.bound. */
  private async recoverBindingPreparations(): Promise<void> {
    const events = await this.store.readAll();
    const closed = new Set(events.flatMap((event) => {
      if (event.event_type === 'reg.binding_aborted' && typeof event.payload.prepare_id === 'string') {
        return [event.payload.prepare_id];
      }
      if (event.event_type === 'reg.bound' && typeof event.payload.binding_prepare_id === 'string') {
        return [event.payload.binding_prepare_id];
      }
      return [];
    }));
    const currentSeats = new Set(buildProjections(events).currentBindings.map((binding) => binding.seat_id));
    for (const prepared of events) {
      if (prepared.event_type !== 'reg.binding_prepared') continue;
      const prepareId = typeof prepared.payload.prepare_id === 'string' ? prepared.payload.prepare_id : null;
      const paneGeneration = typeof prepared.payload.pane_generation === 'string' ? prepared.payload.pane_generation : null;
      if (!prepareId || !paneGeneration || closed.has(prepareId)) continue;
      if (currentSeats.has(prepared.entity_id)) {
        throw new Error(`txd found an unclosed binding preparation behind a current binding at ${prepared.entity_id}`);
      }
      if (await this.tmux.seatGeneration(prepared.entity_id) === paneGeneration) {
        await this.clearBindingTint(prepared.entity_id);
      }
      await this.abortBinding(prepared.entity_id, prepareId, 'boot_recovery', this.prov('observer', null));
    }
  }

  /** Resume every requested scoped reconstruction from event truth. */
  private async recoverScopedResets(): Promise<boolean> {
    let councilRebuilt = false;
    const events = await this.store.readAll();
    const closed = new Set(events
      .filter((event) =>
        event.event_type === 'estate.scoped_reset_completed'
        || event.event_type === 'estate.scoped_reset_failed',
      )
      .map((event) => event.entity_id));
    for (const request of events) {
      if (request.event_type !== 'estate.scoped_reset_requested' || closed.has(request.entity_id)) continue;
      const seats = Array.isArray(request.payload.seats)
        ? request.payload.seats.filter((seat): seat is string => typeof seat === 'string')
        : [];
      const scope = request.payload.scope;
      if (seats.length === 0 || (scope !== 'page' && scope !== 'pane')) {
        throw new Error(`txd cannot resume malformed scoped reset ${request.entity_id}`);
      }
      const snapshots = Array.isArray(request.payload.bound_generations)
        ? request.payload.bound_generations.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const row = candidate as Record<string, unknown>;
          return typeof row.seat_id === 'string'
            && typeof row.bound_seq === 'number'
            && (typeof row.pane_generation === 'string' || row.pane_generation === null)
            ? [{
              seat_id: row.seat_id,
              bound_seq: row.bound_seq,
              pane_generation: row.pane_generation,
            }]
            : [];
        })
        : null;
      if (snapshots === null) {
        await this.store.append({
          entity_type: 'estate',
          entity_id: request.entity_id,
          event_type: 'estate.scoped_reset_failed',
          payload: { ...request.payload, reason: 'binding_generation_snapshot_absent' },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
        continue;
      }
      const current = (await this.projections()).currentBindings
        .filter((binding) => seats.includes(binding.seat_id));
      const unexpected = current.find((binding) => !snapshots.some((snapshot) =>
        snapshot.seat_id === binding.seat_id
        && snapshot.bound_seq === binding.bound_seq
        && snapshot.pane_generation === binding.pane_generation,
      ));
      if (unexpected) {
        throw new Error(`txd fenced scoped reset ${request.entity_id} from newer binding at ${unexpected.seat_id}`);
      }
      const bindings = current.filter((binding) => snapshots.some((snapshot) =>
        snapshot.seat_id === binding.seat_id
        && snapshot.bound_seq === binding.bound_seq
        && snapshot.pane_generation === binding.pane_generation,
      ));
      if (scope === 'page') {
        const page = seats[0]!.split(':', 1)[0];
        if (!page || !isTxdPage(page) || seats.some((seat) => !seat.startsWith(`${page}:`))) {
          throw new Error(`txd cannot resume invalid page reset ${request.entity_id}`);
        }
        if (!(await this.tmux.rebuildPage(page))) {
          throw new Error(`txd failed to resume pending ${page} page reconstruction`);
        }
        if (page === 'council') councilRebuilt = true;
      } else if (!(await this.tmux.resetSeat(seats[0]!))) {
        throw new Error(`txd failed to resume pending ${seats[0]} pane reconstruction`);
      }
      const occurred_at = this.now();
      const inputs = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, null, occurred_at),
      );
      inputs.push({
        entity_type: 'estate',
        entity_id: request.entity_id,
        event_type: 'estate.scoped_reset_completed',
        payload: request.payload,
        provenance: this.prov('observer', null),
        occurred_at,
      });
      await this.store.appendAll(inputs);
      closed.add(request.entity_id);
    }
    return councilRebuilt;
  }

  private wakeAsk(askId: string): void {
    for (const wake of this.commWaiters.get(askId) ?? []) wake();
    this.commWaiters.delete(askId);
  }

  async clipboardPull(req: ClipboardPullRequest): Promise<{ buffer_name: typeof CLIPBOARD_BUFFER_NAME; bytes: number }> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const bytes = await this.tmux.loadClipboard(req.content);
      return { buffer_name: CLIPBOARD_BUFFER_NAME, bytes };
    });
  }

  async clipboardPush(req: ClipboardPushRequest): Promise<{ buffer_name: typeof CLIPBOARD_BUFFER_NAME; bytes: number; content_base64: string }> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const bytes = await this.tmux.readClipboard();
      if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('clipboard payload exceeds 1 MiB');
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('clipboard payload is not valid UTF-8'); }
      return {
        buffer_name: CLIPBOARD_BUFFER_NAME,
        bytes: bytes.byteLength,
        content_base64: Buffer.from(bytes).toString('base64'),
      };
    });
  }

  async clipboardSelection(req: ClipboardSelectionRequest): Promise<{ buffer_name: typeof CLIPBOARD_BUFFER_NAME; bytes: number }> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const bytes = await this.tmux.commitClipboardSelection(req.content, req.client_tty);
      return { buffer_name: CLIPBOARD_BUFFER_NAME, bytes };
    });
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
      const pendingResetSeats = this.pendingScopedResetSeats(events);
      const fenced = targets.find((target) => pendingResetSeats.has(target.seat_id));
      if (fenced) throw new Error(`scoped_reset_pending: ${fenced.seat_id}`);
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

  transitionMode(
    req: ModeTransitionRequest,
    transportReceipt: string | null = null,
  ): Promise<ModeTransitionResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      }
      const proj = await this.projections();
      const matches = proj.currentBindings.filter((binding) =>
        binding.instance_id === req.target
        || binding.persona === req.target
        || binding.seat_id === req.target,
      );
      if (matches.length === 0) throw new Error(`identity_absent: ${req.target}`);
      if (matches.length > 1) throw new Error(`identity_ambiguous: ${req.target}`);
      const binding = matches[0]!;
      if (!binding.instance_id || !binding.engine) {
        throw new Error(`engine_unattested: ${req.target}`);
      }
      const occurred_at = this.now();
      const requested = await this.store.append({
        entity_type: 'instance',
        entity_id: binding.instance_id,
        event_type: 'act.mode_transition_requested',
        payload: {
          seat_id: binding.seat_id,
          engine: binding.engine,
          intent: req.intent,
          trigger: req.trigger,
        },
        provenance: this.prov('wrapper', transportReceipt),
        occurred_at,
      });

      let outcome: Awaited<ReturnType<TmuxControlPlane['transitionAgentMode']>>;
      try {
        outcome = await this.tmux.transitionAgentMode(binding.seat_id, binding.engine, req.intent);
      } catch {
        outcome = {
          before: 'unknown',
          after: 'unknown',
          changed: false,
          verified: false,
          mechanism: 'none',
        };
      }
      const terminal = await this.store.append({
        entity_type: 'instance',
        entity_id: binding.instance_id,
        event_type: outcome.verified
          ? 'act.mode_transition_attested'
          : 'act.mode_transition_failed',
        payload: {
          request_seq: requested.seq,
          seat_id: binding.seat_id,
          engine: binding.engine,
          intent: req.intent,
          trigger: req.trigger,
          before: outcome.before,
          after: outcome.after,
          changed: outcome.changed,
          mechanism: outcome.mechanism,
          reason: outcome.verified ? null : 'transition_unverified',
        },
        provenance: this.prov('observer', transportReceipt),
        occurred_at: this.now(),
      });
      return {
        ok: outcome.verified,
        target: req.target,
        seat_id: binding.seat_id,
        instance_id: binding.instance_id,
        engine: binding.engine,
        intent: req.intent,
        trigger: req.trigger,
        ...outcome,
        event_ids: [requested.seq, terminal.seq],
        reason: outcome.verified ? null : 'transition_unverified',
      };
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
      const askIds = new Set(events
        .filter((e) => e.event_type === 'reg.comm_accepted' && typeof e.payload.ask_id === 'string')
        .map((e) => String(e.payload.ask_id)));
      const asks = events.filter((e) => e.event_type === 'reg.comm_target_snapshotted'
        && askIds.has(e.entity_id)
        && (e.payload.targets as CommTarget[]).some((t) => t.instance_id === instanceId));
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
      if (this.pendingScopedResetSeats(await this.store.readAll()).has(req.seat_id)) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `scoped_reset_pending: ${req.seat_id}`,
        };
      }
      if (proj.decommissionedSeats.has(req.seat_id)) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `seat_decommissioned: ${req.seat_id}`,
        };
      }
      if (STATIC_PERSONAS.some((declaration) => declaration.seat === req.seat_id)) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `static_seat_requires_handshake: ${req.seat_id}`,
        };
      }
      const seatBinding = proj.currentBindings.find((binding) => binding.seat_id === req.seat_id);
      if (seatBinding) {
        const exactRepeat = seatBinding.instance_id === req.identity
          && seatBinding.persona === req.persona
          && seatBinding.tint === req.tint
          && seatBinding.rank === (req.rank ?? null)
          && seatBinding.commander === (req.commander ?? null);
        if (exactRepeat) {
          if (await this.tmux.seatTint(req.seat_id) !== req.tint
            || await this.tmux.seatGeneration(req.seat_id) !== seatBinding.pane_generation) {
            return {
              ok: false,
              seat_id: req.seat_id,
              handover: false,
              missing_attestations: [],
              reason: 'binding_physical_attestation_mismatch',
            };
          }
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

      const paneGeneration = await this.tmux.seatGeneration(req.seat_id);
      if (!paneGeneration) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: 'pane_generation_unattested',
        };
      }
      const prepareId = await this.prepareBinding(req.seat_id, paneGeneration, {
        wrapper_id: null,
        instance_id: req.identity,
        persona: req.persona,
        tint: req.tint,
        rank: req.rank ?? null,
        commander: req.commander ?? null,
      }, prov, occurred_at);
      if (!(await this.applyBindingTint(req.seat_id, req.tint!))) {
        await this.abortBinding(req.seat_id, prepareId, 'tint_attestation_failed', prov);
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: 'tint_attestation_failed',
        };
      }

      // Atomic logical bind: the full tuple in ONE event, only after physical
      // tint has been applied and read back. Store failure compensates fail-dark.
      try {
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
            pane_generation: paneGeneration,
            binding_prepare_id: prepareId,
          },
          provenance: prov,
          occurred_at,
        });
      } catch (error) {
        await this.compensateBindingCommitFailure(req.seat_id, prepareId, prov, error);
      }

      return { ok: true, seat_id: req.seat_id, handover: true, missing_attestations: [], reason: null };
    });
  }

  // ── constructEstate — boot-time idempotent ensure (estate, rung 2) ──────
  // Stands the canonical persistent estate (src/estate.ts) declaratively. NOT an
  // endpoint or CLI — the seed vocab/endpoint set is closed; this is a boot
  // ensure. Runs under the single-writer mutex so it can't interleave with a
  // concurrent launch or comm. Idempotent: a re-run over a fully-present-and-attested
  // estate creates nothing and appends zero events. Each fresh seat records ONE
  // bare `reg.pane_created` (unbound) — it lands in freelist + activity_board and
  // triggers NO contradiction (reconcile only flags bound-dead / retired-live).
  //
  // Buckets: `created` = canonical pane made + event written this run;
  // `backfilled` = canonical pane already there but its event was missing;
  // `existing` = present AND attested. `failed` remains in the response contract
  // but shape failures throw before any event append: half-estates are refused.
  async constructEstate(): Promise<{ created: string[]; existing: string[]; backfilled: string[]; failed: string[] }> {
    const result = await this.locked(async () => {
      await this.recoverBindingPreparations();
      const before = await this.store.readAll();
      const lastMigrationRequest = before.findLast((event) =>
        event.entity_id === COUNCIL_MIGRATION_ID && event.event_type === 'estate.topology_migration_requested',
      );
      const lastMigrationCompletion = before.findLast((event) =>
        event.entity_id === COUNCIL_MIGRATION_ID && event.event_type === 'estate.topology_migration_completed',
      );
      let pendingMigration = lastMigrationRequest !== undefined
        && (lastMigrationCompletion === undefined || lastMigrationRequest.seq > lastMigrationCompletion.seq);
      const generation = await this.tmux.estateGeneration();
      if (generation === 'council-mechanicus' && !pendingMigration) {
        await this.store.append({
          entity_type: 'estate',
          entity_id: COUNCIL_MIGRATION_ID,
          event_type: 'estate.topology_migration_requested',
          payload: { from: 'council-mechanicus', to: 'council' },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
        pendingMigration = true;
      }
      if (generation === 'migration-interrupted' && !pendingMigration) {
        throw new Error('txd refused unrequested interrupted Council topology migration');
      }
      if (pendingMigration) {
        const bindings = (await this.projections()).currentBindings.filter((binding) =>
          binding.seat_id.startsWith('council:') || binding.seat_id.startsWith('mechanicus:'),
        );
        if (!(await this.tmux.migrateCouncil(true))) throw new Error('txd failed Council topology migration');
        const occurred_at = this.now();
        const provenance = this.prov('observer', null);
        const inputs: EventInput[] = [];
        for (const binding of bindings) {
          if (binding.instance_id) {
            inputs.push({
              entity_type: 'instance',
              entity_id: binding.instance_id,
              event_type: 'reg.retired',
              payload: {},
              provenance,
              occurred_at,
            });
          }
          inputs.push({
            entity_type: 'seat',
            entity_id: binding.seat_id,
            event_type: 'reg.process_reaped',
            payload: { instance_id: binding.instance_id },
            provenance,
            occurred_at,
          });
          inputs.push({
            entity_type: 'seat',
            entity_id: binding.seat_id,
            event_type: 'reg.seat_cleared',
            payload: {},
            provenance,
            occurred_at,
          });
        }
        for (const seat of DECOMMISSIONED_COUNCIL_SEATS) {
          inputs.push({
            entity_type: 'seat',
            entity_id: seat,
            event_type: 'reg.seat_decommissioned',
            payload: { migration_id: COUNCIL_MIGRATION_ID },
            provenance,
            occurred_at,
          });
        }
        inputs.push({
          entity_type: 'estate',
          entity_id: COUNCIL_MIGRATION_ID,
          event_type: 'estate.topology_migration_completed',
          payload: { canonical_seats: TXD_ESTATE.length },
          provenance,
          occurred_at,
        });
        await this.store.appendAll(inputs);
      } else if (generation === 'foreign') {
        throw new Error('txd refused non-canonical existing tmux estate');
      }

      await this.recoverScopedResets();

      // Boot-observed Council damage must enter the same durable page-reset
      // state machine as lifecycle ingress before any physical repair occurs.
      // An empty estate is constructed below; there is no old page to retire.
      if (generation !== 'empty') {
        const expectedCouncil = [...TXD_WINDOWS.council].sort();
        const liveCouncil = (await this.tmux.listSeats())
          .filter((seat) => seat.seat_id.startsWith('council:') && seat.pane === 'live')
          .map((seat) => seat.seat_id)
          .sort();
        const councilBindings = (await this.projections()).currentBindings
          .filter((binding) => binding.seat_id.startsWith('council:'));
        let bindingProjectionHealthy = true;
        for (const binding of councilBindings) {
          const declaration = STATIC_PERSONAS.find((candidate) => candidate.seat === binding.seat_id);
          if (!declaration
            || binding.persona !== declaration.persona
            || binding.tint !== declaration.tint
            || binding.pane_generation !== await this.tmux.seatGeneration(binding.seat_id)
            || await this.tmux.seatTint(binding.seat_id) !== declaration.tint) {
            bindingProjectionHealthy = false;
          }
        }
        for (const seat of TXD_WINDOWS.council) {
          if (!councilBindings.some((binding) => binding.seat_id === seat)
            && await this.tmux.seatTint(seat) !== null) {
            bindingProjectionHealthy = false;
          }
        }
        const councilHealthy = bindingProjectionHealthy
          && liveCouncil.length === expectedCouncil.length
          && liveCouncil.every((seat, index) => seat === expectedCouncil[index]);
        if (!councilHealthy) {
          const rotationId = crypto.randomUUID();
          await this.store.append({
            entity_type: 'estate',
            entity_id: rotationId,
            event_type: 'estate.scoped_reset_requested',
            payload: {
              scope: 'page',
              seats: [...TXD_WINDOWS.council],
              force: true,
              bound_seats: (await this.projections()).currentBindings
                .filter((binding) => binding.seat_id.startsWith('council:'))
                .map((binding) => binding.seat_id)
                .sort(),
              bound_generations: councilBindings.map((binding) => ({
                seat_id: binding.seat_id,
                bound_seq: binding.bound_seq,
                pane_generation: binding.pane_generation,
              })),
              foreground_workloads: [],
              trigger: 'boot-observer',
            },
            provenance: this.prov('observer', null),
            occurred_at: this.now(),
          });
        }
      }
      // The observer above may have opened a reset for a contradiction found
      // during this same boot. Execute it through the same replayable path.
      await this.recoverScopedResets();

      // Construction is all-or-nothing below the membrane: create on an empty
      // socket, accept the exact canonical shape, refuse every other estate.
      const estate = await this.tmux.ensureEstate();
      // A repaired page contains entirely new terminal processes, even when tmux
      // reused one pane object as the reconstruction seed. Resolve every binding
      // in that border into event truth before the fresh bare seats are exposed.
      const rebuiltPages = new Set(estate.rebuilt_pages);
      const bindings = (await this.projections()).currentBindings.filter((binding) => {
        const page = binding.seat_id.split(':', 1)[0];
        return page !== undefined && isTxdPage(page) && rebuiltPages.has(page);
      });
      const bootRetirements = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, null, this.now()),
      );
      if (bootRetirements.length > 0) await this.store.appendAll(bootRetirements);
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
        (estate.state === 'created' ? created : backfilled).push(seat);
      }

      // Decommission is declaration-level truth, not a side effect that exists
      // only on machines which happened to migrate the preceding topology.
      // Emit missing facts only after the canonical estate postcondition holds.
      const decommissioned = (await this.projections()).decommissionedSeats;
      const missingDecommissions = DECOMMISSIONED_COUNCIL_SEATS
        .filter((seat) => !decommissioned.has(seat))
        .map((seat): EventInput => ({
          entity_type: 'seat',
          entity_id: seat,
          event_type: 'reg.seat_decommissioned',
          payload: { migration_id: COUNCIL_MIGRATION_ID },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        }));
      if (missingDecommissions.length > 0) await this.store.appendAll(missingDecommissions);

      return { created, existing, backfilled, failed };
    });
    await this.provisionStaticPersonas(true);
    return result;
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
    const reaped = await this.tmux.reapSeat(binding.seat_id, binding.tint);
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
  async reconcile(transportReceipt: string | null = null): Promise<ReconcileResponse> {
    let councilRebuilt = false;
    const response = await this.locked(async () => {
      councilRebuilt = await this.recoverScopedResets();
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
          continue;
        }
        const observedTint = await this.tmux.seatTint(b.seat_id);
        const observedGeneration = await this.tmux.seatGeneration(b.seat_id);
        if (observedGeneration !== b.pane_generation) {
          await flag(
            b.seat_id,
            'bound_generation_mismatch',
            'pane_generation',
            `seat binding expects pane generation=${b.pane_generation ?? 'missing'} but tmux attests ${observedGeneration ?? 'absent'}`,
          );
        }
        if (observedTint !== b.tint) {
          await flag(
            b.seat_id,
            'bound_tint_mismatch',
            'tint',
            `seat binding expects tint=${b.tint ?? 'null'} but tmux attests ${observedTint ?? 'untinted'}`,
          );
        }
      }
      for (const seat of observed) {
        if (seat.pane !== 'live' || proj.currentBindings.some((binding) => binding.seat_id === seat.seat_id)) continue;
        const observedTint = await this.tmux.seatTint(seat.seat_id);
        if (observedTint !== null) {
          await flag(
            seat.seat_id,
            'unbound_tint_present',
            'binding',
            `unbound seat physically attests tint=${observedTint ?? 'unreadable'}`,
          );
        }
      }
      // Phantom seat: the ledger still projects a pane tmux does not report at
      // all. `paneBySeat` is only ever removed from by reg.seat_decommissioned —
      // reg.seat_cleared clears the binding and leaves the pane axis untouched
      // by design, and reg.process_reaped has no pane effect — so a seat that
      // was reaped and cleared, or quietly dropped from the estate declaration,
      // survives in every estate read with nothing behind it. The BOUND half of
      // this is already bound_pane_dead above (it folds pane === undefined);
      // the unbound half was iterated by nothing, because this loop reads the
      // fold and the loop above reads tmux, and a phantom is in neither.
      //
      // The fold itself stays a pure replay projection: reconciling it against
      // observed reality is this pass's job, not buildProjections'.
      for (const row of proj.activityBoard) {
        if (row.seat_id === null || row.binding === 'bound') continue;
        if (observedPane.has(row.seat_id)) continue;
        await flag(
          row.seat_id,
          'pane_absent',
          'seat_decommissioned',
          `seat is projected (pane=${row.pane}, unbound) but tmux reports no pane for it — every estate read counts a seat that does not exist`,
        );
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
    if (councilRebuilt) await this.provisionStaticPersonas();
    return response;
  }

  // ── Read model (spec §7 rung 6, reshaped [[txd-extraction-spec]] §6) ────────
  // The estate observation view behind `GET /tmux/read/estate` — txd's ONLY
  // public read surface. Per-entity event history is NOT served publicly:
  // the stream stays private replay/reconcile truth (biography serving is not
  // txd's job).
  async estateRows(): Promise<ActivityBoardRow[]> {
    return (await this.projections()).activityBoard;
  }

  async tintReadiness(): Promise<TintReadiness[]> {
    const proj = await this.projections();
    const observedSeats = await this.tmux.listSeats();
    const paneBySeat = new Map(observedSeats.map((seat) => [seat.seat_id, seat.pane]));
    const bindingBySeat = new Map(proj.currentBindings.map((binding) => [binding.seat_id, binding]));
    const seats = new Set([
      ...TXD_ESTATE,
      ...observedSeats.map((seat) => seat.seat_id),
      ...proj.currentBindings.map((binding) => binding.seat_id),
    ]);
    const rows: TintReadiness[] = [];
    for (const seat_id of [...seats].sort()) {
      const binding = bindingBySeat.get(seat_id);
      const expected = binding?.tint ?? null;
      const observed = await this.tmux.seatTint(seat_id);
      const generationReady = !binding
        || await this.tmux.seatGeneration(seat_id) === binding.pane_generation;
      const pane = paneBySeat.get(seat_id);
      rows.push({
        seat_id,
        binding: binding ? 'bound' : 'unbound',
        expected,
        observed: observed ?? null,
        state: pane !== 'live' || observed === undefined
          ? 'missing'
          : observed === expected && generationReady ? 'ready' : 'mismatched',
      });
    }
    return rows;
  }

  async staticPersonaReadiness(): Promise<Array<{
    seat_id: string;
    state: 'ready' | 'missing' | 'mismatched' | 'awaiting_ack';
    instance_id: string | null;
    tint: string;
    tint_attested: boolean;
  }>> {
    const proj = await this.projections();
    const launches = [...proj.staticLaunches.values()];
    const rows: Array<{
      seat_id: string;
      state: 'ready' | 'missing' | 'mismatched' | 'awaiting_ack';
      instance_id: string | null;
      tint: string;
      tint_attested: boolean;
    }> = [];
    for (const declaration of STATIC_PERSONAS) {
      const binding = proj.currentBindings.find((candidate) => candidate.seat_id === declaration.seat);
      if (!binding) {
        const pending = launches.findLast((launch) =>
          launch.seat_id === declaration.seat && launch.state === 'awaiting_ack',
        );
        rows.push({
          seat_id: declaration.seat,
          state: pending ? 'awaiting_ack' : 'missing',
          instance_id: pending?.instance_id ?? null,
          tint: declaration.tint,
          tint_attested: false,
        });
        continue;
      }
      const tupleMatches =
        binding.persona === declaration.persona
        && binding.tint === declaration.tint
        && binding.rank === declaration.rank
        && binding.commander === declaration.commander
        && binding.engine === declaration.engine
        && binding.authority_principal === declaration.authority_principal
        && binding.continuity_kind === declaration.continuity_kind
        && binding.wrapper_pid !== null
        && binding.engine_pid !== null
        && binding.engine_executable !== null
        && binding.static_launch_id !== null;
      const alive = tupleMatches && await this.tmux.attestStaticAgent(
        declaration.seat,
        binding.wrapper_pid!,
        binding.engine_pid!,
        declaration.engine,
        binding.engine_executable!,
      );
      const tint_attested = await this.tmux.seatTint(declaration.seat) === declaration.tint;
      const generation_attested = binding.pane_generation !== null
        && await this.tmux.seatGeneration(declaration.seat) === binding.pane_generation;
      rows.push({
        seat_id: declaration.seat,
        state: alive && tint_attested && generation_attested ? 'ready' : 'mismatched',
        instance_id: binding.instance_id,
        tint: declaration.tint,
        tint_attested,
      });
    }
    return rows;
  }

  provisionStaticPersonas(recoverPending = false): Promise<void> {
    return this.locked(async () => {
      if (!this.staticRuntime) return;
      let proj = await this.projections();
      if (recoverPending) {
        const interrupted = [...proj.staticLaunches.values()]
          .filter((launch) => launch.state === 'awaiting_ack')
          .map((launch): EventInput => ({
            entity_type: 'instance',
            entity_id: launch.launch_id,
            event_type: 'reg.static_launch_failed',
            payload: {
              reason: 'daemon_restarted_before_ack',
              seat_id: launch.seat_id,
              instance_id: launch.instance_id,
            },
            provenance: this.prov('observer', null),
            occurred_at: this.now(),
          }));
        if (interrupted.length > 0) {
          await this.store.appendAll(interrupted);
          proj = await this.projections();
        }
      }
      for (const declaration of STATIC_PERSONAS) {
        const binding = proj.currentBindings.find((candidate) => candidate.seat_id === declaration.seat);
        if (binding) continue;
        const latest = [...proj.staticLaunches.values()].findLast((launch) => launch.seat_id === declaration.seat);
        if (latest?.state === 'awaiting_ack') continue;

        const launch_id = crypto.randomUUID();
        const instance_id = crypto.randomUUID();
        const token = crypto.randomUUID();
        const token_hash = new Bun.CryptoHasher('sha256').update(token).digest('hex');
        const occurred_at = this.now();
        await this.store.append({
          entity_type: 'instance',
          entity_id: launch_id,
          event_type: 'reg.static_launch_requested',
          payload: {
            seat_id: declaration.seat,
            instance_id,
            engine: declaration.engine,
            persona: declaration.persona,
            rank: declaration.rank,
            commander: declaration.commander,
            authority_principal: declaration.authority_principal,
            continuity_kind: declaration.continuity_kind,
            tint: declaration.tint,
            token_hash,
          },
          provenance: this.prov('observer', null),
          occurred_at,
        });
        const started = await this.tmux.startStaticAgent({
          seatId: declaration.seat,
          engine: declaration.engine,
          wrapper: this.staticRuntime.agentWrapper,
          workspace: `${this.staticRuntime.personaWorkspaceRoot}/${declaration.workspace}`,
          environment: {
            TXD_STATIC_LAUNCH_ID: launch_id,
            TXD_STATIC_LAUNCH_TOKEN: token,
            TXD_STATIC_INSTANCE_ID: instance_id,
            TXD_STATIC_SEAT: declaration.seat,
            TXD_STATIC_ACK_URL: this.staticRuntime.acknowledgeUrl,
            TXD_STATIC_ENGINE: declaration.engine,
            TXD_STATIC_OBSIDIAN_PERSONA: declaration.persona,
          },
        });
        if (!started) {
          await this.store.append({
            entity_type: 'instance',
            entity_id: launch_id,
            event_type: 'reg.static_launch_failed',
            payload: { reason: 'wrapper_start_failed', seat_id: declaration.seat, instance_id },
            provenance: this.prov('observer', null),
            occurred_at: this.now(),
          });
        }
      }
    });
  }

  acknowledgeStaticLaunch(handshake: StaticLaunchHandshake): Promise<StaticLaunchHandshakeResponse> {
    return this.locked(async () => {
      const proj = await this.projections();
      const launch = proj.staticLaunches.get(handshake.launch_id);
      if (!launch || launch.state !== 'awaiting_ack') {
        return { ok: false, acknowledged: false, reason: 'launch_absent_or_closed' };
      }
      const token_hash = new Bun.CryptoHasher('sha256').update(handshake.token).digest('hex');
      if (token_hash !== launch.token_hash) {
        return { ok: false, acknowledged: false, reason: 'launch_authentication_failed' };
      }
      const declaration = STATIC_PERSONAS.find((candidate) => candidate.seat === launch.seat_id);
      const tupleMatches = declaration
        && handshake.instance_id === launch.instance_id
        && handshake.seat_id === launch.seat_id
        && handshake.engine === launch.engine
        && handshake.engine === declaration.engine
        && launch.tint === declaration.tint;
      const physicallyAttested = tupleMatches && await this.tmux.attestStaticAgent(
        handshake.seat_id,
        handshake.wrapper_pid,
        handshake.engine_pid,
        handshake.engine,
        handshake.engine_executable,
      );
      if (!tupleMatches || !physicallyAttested) {
        await this.store.append({
          entity_type: 'instance',
          entity_id: handshake.launch_id,
          event_type: 'reg.static_launch_failed',
          payload: {
            reason: tupleMatches ? 'physical_attestation_failed' : 'launch_tuple_mismatch',
            seat_id: launch.seat_id,
            instance_id: launch.instance_id,
          },
          provenance: this.prov('wrapper', null),
          occurred_at: this.now(),
        });
        return { ok: false, acknowledged: false, reason: 'launch_attestation_failed' };
      }
      const occupied = proj.currentBindings.some((binding) =>
        binding.seat_id === declaration.seat || binding.instance_id === launch.instance_id,
      );
      if (occupied) return { ok: false, acknowledged: false, reason: 'binding_conflict' };
      if (this.pendingScopedResetSeats(await this.store.readAll()).has(declaration.seat)) {
        return { ok: false, acknowledged: false, reason: 'scoped_reset_pending' };
      }
      const paneGeneration = await this.tmux.seatGeneration(declaration.seat);
      if (!paneGeneration) return { ok: false, acknowledged: false, reason: 'pane_generation_unattested' };
      const provenance = this.prov('wrapper', null);
      const occurred_at = this.now();
      const prepareId = await this.prepareBinding(declaration.seat, paneGeneration, {
        wrapper_id: handshake.launch_id,
        instance_id: handshake.instance_id,
        persona: declaration.persona,
        rank: declaration.rank,
        commander: declaration.commander,
        tint: declaration.tint,
        engine: declaration.engine,
        engine_executable: handshake.engine_executable,
        static_launch_id: handshake.launch_id,
      }, provenance, occurred_at);
      if (!(await this.applyBindingTint(declaration.seat, declaration.tint))) {
        await this.abortBinding(declaration.seat, prepareId, 'tint_attestation_failed', provenance);
        return { ok: false, acknowledged: false, reason: 'tint_attestation_failed' };
      }
      try {
        await this.store.append({
          entity_type: 'seat',
          entity_id: declaration.seat,
          event_type: 'reg.bound',
          payload: {
            wrapper_id: handshake.launch_id,
            instance_id: handshake.instance_id,
            persona: declaration.persona,
            rank: declaration.rank,
            commander: declaration.commander,
            tint: declaration.tint,
            engine: declaration.engine,
            static_launch_id: handshake.launch_id,
            wrapper_pid: handshake.wrapper_pid,
            engine_pid: handshake.engine_pid,
            engine_executable: handshake.engine_executable,
            authority_principal: declaration.authority_principal,
            continuity_kind: declaration.continuity_kind,
            pane_generation: paneGeneration,
            binding_prepare_id: prepareId,
          },
          provenance,
          occurred_at,
        });
      } catch (error) {
        await this.compensateBindingCommitFailure(
          declaration.seat,
          prepareId,
          provenance,
          error,
        );
      }
      return { ok: true, acknowledged: true, reason: null };
    });
  }

  requestEstateRotation(req: EstateRotateRequest, transportReceipt: string | null = null): Promise<EstateRotateResponse> {
    return this.locked(async () => {
      if (req.scope !== 'estate') {
        return { ok: false, rotation_id: null, accepted: false, force: req.force, scope: req.scope, seats: [], bound_seats: [], foreground_workloads: [], reason: 'scoped_reset_requires_in_process_path' };
      }
      if (req.schema_version !== SCHEMA_VERSION) {
        return { ok: false, rotation_id: null, accepted: false, force: req.force, scope: 'estate', seats: [], bound_seats: [], foreground_workloads: [], reason: 'schema_version_mismatch' };
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
        return { ok: false, rotation_id, accepted: false, force: false, scope: 'estate', seats: [...TXD_ESTATE], bound_seats, foreground_workloads, reason: 'estate_busy' };
      }
      await this.rotationBarrier.begin();
      try {
        await this.store.append({ entity_type: 'estate', entity_id: rotation_id, event_type: 'estate.rotation_requested', payload, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      } catch (error) {
        await this.rotationBarrier.abort();
        throw error;
      }
      return { ok: true, rotation_id, accepted: true, force: req.force, scope: 'estate', seats: [...TXD_ESTATE], bound_seats, foreground_workloads, reason: null };
    });
  }

  /**
   * Reset a page or canonical pane without killing the estate server. Pane
   * scope replaces one process in place. Page scope is border-total: the tmux
   * adapter wipes every terminal process, history, user option, and split in
   * the window, then stands the full declared geometry before txd retires all
   * old bindings in the page.
   */
  async resetEstateScope(req: EstateRotateRequest, transportReceipt: string | null = null): Promise<EstateRotateResponse> {
    const result = await this.locked(() => this.resetEstateScopeUnlocked(req, transportReceipt));
    if (result.ok && result.scope === 'page' && req.page === 'council') await this.provisionStaticPersonas();
    return result;
  }

  private async resetEstateScopeUnlocked(
    req: EstateRotateRequest,
    transportReceipt: string | null,
    trigger: 'operator' | 'pane-died' | 'pane-exited' = 'operator',
  ): Promise<EstateRotateResponse> {
    const scope = req.scope;
    const empty = (reason: string): EstateRotateResponse => ({
        ok: false, rotation_id: null, accepted: false, force: req.force, scope, seats: [], bound_seats: [], foreground_workloads: [], reason,
    });
      if (req.schema_version !== SCHEMA_VERSION) return empty('schema_version_mismatch');
      if (scope === 'estate') return empty('estate_scope_requires_rotation_handoff');
      const seats = scope === 'page'
        ? TXD_ESTATE.filter((seat) => seat.split(':', 1)[0] === req.page)
        : TXD_ESTATE.filter((seat) => seat === req.pane);
      if (seats.length === 0) return empty('scope_absent');

      const proj = await this.projections();
      const bindings = proj.currentBindings.filter((binding) => seats.includes(binding.seat_id));
      const bound_seats = bindings.map((binding) => binding.seat_id).sort();
      const foreground_workloads = (await this.tmux.workloads())
        .filter((workload) => seats.includes(workload.seat_id) && !workload.idle)
        .map(({ seat_id, command }) => ({ seat_id, command }))
        .sort((a, b) => a.seat_id.localeCompare(b.seat_id));
      const rotation_id = crypto.randomUUID();
      const occurred_at = this.now();
      const payload = {
        scope,
        seats,
        force: req.force,
        bound_seats,
        bound_generations: bindings.map((binding) => ({
          seat_id: binding.seat_id,
          bound_seq: binding.bound_seq,
          pane_generation: binding.pane_generation,
        })),
        foreground_workloads,
        trigger,
      };
      if ((bound_seats.length > 0 || foreground_workloads.length > 0) && !req.force) {
        await this.store.append({ entity_type: 'estate', entity_id: rotation_id, event_type: 'estate.scoped_reset_refused', payload, provenance: this.prov('wrapper', transportReceipt), occurred_at });
        return { ok: false, rotation_id, accepted: false, force: false, scope, seats, bound_seats, foreground_workloads, reason: 'estate_busy' };
      }
      const provenance = this.prov(trigger === 'operator' ? 'wrapper' : 'observer', transportReceipt);
      await this.store.append({ entity_type: 'estate', entity_id: rotation_id, event_type: 'estate.scoped_reset_requested', payload, provenance, occurred_at });
      if (scope === 'page') {
        if (!(await this.tmux.rebuildPage(req.page!))) {
          // Leave the durable request open. Boot resumes the same typed reset;
          // closing it as "failed" after a partial physical rebuild would strand
          // old binding truth against replacement pane generations.
          return { ok: false, rotation_id, accepted: false, force: req.force, scope, seats, bound_seats, foreground_workloads, reason: 'reset_failed' };
        }
      } else {
        const seat = seats[0]!;
        if (!(await this.tmux.resetSeat(seat))) {
          // Keep the request pending for reconstruction recovery; the physical
          // adapter may already have replaced the process before verification.
          return { ok: false, rotation_id, accepted: false, force: req.force, scope, seats, bound_seats, foreground_workloads, reason: 'reset_failed' };
        }
      }
      const completedAt = this.now();
      const inputs = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, transportReceipt, completedAt),
      );
      inputs.push({
        entity_type: 'estate',
        entity_id: rotation_id,
        event_type: 'estate.scoped_reset_completed',
        payload,
        provenance: this.prov('observer', transportReceipt),
        occurred_at: completedAt,
      });
      await this.store.appendAll(inputs);
    return { ok: true, rotation_id, accepted: true, force: req.force, scope, seats, bound_seats, foreground_workloads, reason: null };
  }

  async handleTmuxLifecycleEvent(
    req: TmuxLifecycleEventRequest,
    transportReceipt: string | null = null,
  ): Promise<TmuxLifecycleEventResponse> {
    const result = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return { ok: false, event: req.event, page: req.page, reconstructed: false, rotation_id: null, reason: 'schema_version_mismatch' };
      }
      if (!isTxdPage(req.page)) {
        return { ok: false, event: req.event, page: req.page, reconstructed: false, rotation_id: null, reason: 'page_absent' };
      }
      const expected = [...TXD_WINDOWS[req.page]].sort();
      const observed = (await this.tmux.listSeats()).filter((seat) => seat.seat_id.startsWith(`${req.page}:`));
      const live = observed.filter((seat) => seat.pane === 'live').map((seat) => seat.seat_id).sort();
      const canonical = live.length === expected.length && live.every((seat, index) => seat === expected[index]);
      if (canonical) {
        return { ok: true, event: req.event, page: req.page, reconstructed: false, rotation_id: null, reason: 'page_already_canonical' };
      }
      const reset = await this.resetEstateScopeUnlocked(
        { schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: req.page },
        transportReceipt,
        req.event,
      );
      return {
        ok: reset.ok,
        event: req.event,
        page: req.page,
        reconstructed: reset.accepted,
        rotation_id: reset.rotation_id,
        reason: reset.reason,
      };
    });
    if (result.ok && result.reconstructed && result.page === 'council') await this.provisionStaticPersonas();
    return result;
  }

  private resetBindingInputs(
    binding: CurrentBinding,
    transportReceipt: string | null,
    occurred_at: string,
  ): EventInput[] {
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.instance_id) inputs.push({ entity_type: 'instance', entity_id: binding.instance_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { instance_id: binding.instance_id }, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_cleared', payload: {}, provenance: prov, occurred_at });
    return inputs;
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
    const static_personas = await this.staticPersonaReadiness();
    const tints = await this.tintReadiness();
    return {
      ok: open === 0
        && tmux_reachable
        && static_personas.every((persona) => persona.state === 'ready')
        && tints.every((tint) => tint.state === 'ready'),
      service: 'txd' as const,
      schema_version: SCHEMA_VERSION,
      version: build.version,
      git_sha: build.git_sha,
      bun: build.bun,
      machine,
      events: await this.store.count(),
      open_contradictions: open,
      tmux_reachable,
      static_personas,
      tints,
    };
  }
}

export type { EventInput };
