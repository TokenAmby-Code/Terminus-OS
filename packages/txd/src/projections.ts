// Projections (spec §10) — the three day-one read models, ALL rebuilt purely by
// replay. Nobody writes them; they are a fold over the event stream. Open
// contradictions get NO table — "currently contradicted" is a stream filter.
//
// Payload conventions (dumb facts; the fold denormalizes on the read side):
//   reg.pane_created   (seat)     payload.pane_state? = 'live' | 'empty'   (default 'live')
//   reg.bound          (seat)     payload {wrapper_id, instance_id, persona, tint}  — bound_seq = event.seq
//   reg.seat_cleared   (seat)     clears the binding (pane axis untouched)
//   reg.teardown_started(seat)    pane → 'dead' (teardown kills the pane)
//   reg.process_reaped (seat)     pane → 'dead'
//   act.prompt_submitted(instance) activity → 'working'
//   act.stop_reported  (instance) activity → 'stopped'
//   reg.retired        (instance) activity → 'retired'
//   act.send_enqueued  (send)     payload.target = seat canonical id → queue_depth +1
//   act.send_delivered (send)     payload.target → queue_depth -1   (gated is a no-op: still enqueued)
//   reg.contradiction_flagged     open unless a later event exists on the same entity_id

import { PANE_STATES } from '@terminus-os/contracts';
import type {
  ActivityBoardRow,
  ActivityState,
  CurrentBinding,
  EventRecord,
  FreelistEntry,
  OpenContradiction,
  PaneState,
} from '@terminus-os/contracts';

export type Projections = {
  currentBindings: CurrentBinding[];
  freelist: FreelistEntry[];
  activityBoard: ActivityBoardRow[];
  openContradictions: OpenContradiction[];
  // Per-instance activity fold (working|idle|stopped|retired), exposed so the
  // stop-ingestion door can dedupe (already-stopped/retired) without re-reading.
  activityByInstance: Map<string, ActivityState>;
  // Every instance id that EVER carried a reg.bound — the "did it walk through
  // the door?" oracle. A stop for an id absent here is a ghost (never bound).
  everBoundInstances: Set<string>;
  // Instance ids with an OPEN close-on-stop subscription: a reg.stop_subscribed
  // whose next act.stop_reported has not yet folded (satiated-once). The stop
  // door reads this to fire the reflexive auto-close.
  openStopSubscriptions: Set<string>;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Only accept a declared PaneState; an unexpected/typo'd payload string must not
// slip through as a bogus state and corrupt the freelist/board reads.
function paneState(v: unknown): PaneState {
  const s = str(v);
  return s && (PANE_STATES as readonly string[]).includes(s) ? (s as PaneState) : 'live';
}

export function buildProjections(events: EventRecord[]): Projections {
  const paneBySeat = new Map<string, PaneState>();
  const bindingBySeat = new Map<string, CurrentBinding>();
  const activityByInstance = new Map<string, ActivityState>();
  const everBoundInstances = new Set<string>();
  const subscribeSeqByInstance = new Map<string, number>(); // last reg.stop_subscribed seq
  const lastStopSeqByInstance = new Map<string, number>(); // last act.stop_reported seq
  const queueByTarget = new Map<string, number>();
  const contradictions: OpenContradiction[] = [];
  const resolvedContradictions = new Set<string>();
  const readinessByInstance = new Map<string, number>();
  const routeByInstance = new Map<string, { state: 'active' | 'suspended' | 'retired'; generation: number; reason: string | null }>();

  for (const e of events) {
    switch (e.event_type) {
      case 'reg.pane_created':
        paneBySeat.set(e.entity_id, paneState(e.payload.pane_state));
        break;
      case 'reg.pane_observed':
        paneBySeat.set(e.entity_id, paneState(e.payload.pane_state));
        break;
      case 'reg.teardown_started':
        // A real pane teardown kills the pane. Process death (process_reaped) is a
        // SEPARATE axis: reaping an agent respawns the estate pane bare (still live),
        // so process_reaped intentionally has NO pane effect — pane liveness is a
        // tmux-observed fact, conflating the two would report a live seat as dead.
        if (paneBySeat.has(e.entity_id)) paneBySeat.set(e.entity_id, 'dead');
        break;
      case 'reg.process_reaped':
        break; // witness of terminal retirement (spec §4); moves no projection axis
      case 'reg.bound':
        if (str(e.payload.instance_id)) everBoundInstances.add(str(e.payload.instance_id)!);
        bindingBySeat.set(e.entity_id, {
          seat_id: e.entity_id,
          wrapper_id: str(e.payload.wrapper_id),
          instance_id: str(e.payload.instance_id),
          persona: str(e.payload.persona_id) ?? str(e.payload.persona),
          rank: str(e.payload.rank),
          commander: str(e.payload.commander),
          engine: str(e.payload.engine),
          commander_type: str(e.payload.commander_type),
          commander_id: str(e.payload.commander_id),
          singleton_authority: typeof e.payload.singleton_authority === 'boolean' ? e.payload.singleton_authority : null,
          dispatch_authority: str(e.payload.dispatch_authority),
          session_doc_id: typeof e.payload.session_doc_id === 'number' ? e.payload.session_doc_id : null,
          device_id: str(e.payload.device_id),
          working_dir: str(e.payload.working_dir),
          origin_type: str(e.payload.origin_type),
          execution_placement: str(e.payload.execution_placement),
          tint: str(e.payload.tint),
          registration: 'registered',
          readiness: 'unready',
          routing: 'inactive',
          placement: str(e.payload.device_id) && str(e.payload.working_dir) && str(e.payload.origin_type) && str(e.payload.execution_placement) ? {
            device_id: str(e.payload.device_id)!, working_dir: str(e.payload.working_dir)!, origin_type: str(e.payload.origin_type)!, execution_placement: str(e.payload.execution_placement)!,
          } : null,
          route_closed_reason: 'readiness_not_attested',
          binding_generation: e.seq,
          bound_seq: e.seq,
        });
        break;
      case 'reg.seat_cleared':
        bindingBySeat.delete(e.entity_id);
        break;
      case 'act.prompt_submitted':
        activityByInstance.set(e.entity_id, 'working');
        break;
      case 'act.stop_reported':
        activityByInstance.set(e.entity_id, 'stopped');
        lastStopSeqByInstance.set(e.entity_id, e.seq);
        break;
      case 'reg.stop_subscribed':
        subscribeSeqByInstance.set(e.entity_id, e.seq);
        break;
      case 'reg.retired':
        activityByInstance.set(e.entity_id, 'retired');
        break;
      case 'reg.readiness_attested': {
        const generation = Number(e.payload.binding_generation);
        if (Number.isInteger(generation)) readinessByInstance.set(e.entity_id, generation);
        break;
      }
      case 'reg.route_activated':
      case 'reg.route_suspended':
      case 'reg.route_retired': {
        const generation = Number(e.payload.binding_generation);
        if (Number.isInteger(generation)) routeByInstance.set(e.entity_id, {
          state: e.event_type === 'reg.route_activated' ? 'active' : e.event_type === 'reg.route_retired' ? 'retired' : 'suspended',
          generation,
          reason: str(e.payload.reason),
        });
        break;
      }
      case 'act.send_enqueued': {
        const t = str(e.payload.target);
        if (t) queueByTarget.set(t, (queueByTarget.get(t) ?? 0) + 1);
        break;
      }
      case 'act.send_delivered': {
        const t = str(e.payload.target);
        if (t) queueByTarget.set(t, Math.max(0, (queueByTarget.get(t) ?? 0) - 1));
        break;
      }
      case 'reg.contradiction_flagged':
        contradictions.push({
          seq: e.seq,
          entity_type: e.entity_type,
          entity_id: e.entity_id,
          kind: str(e.payload.kind) ?? 'unknown',
          missing_attestation: str(e.payload.missing_attestation),
          detail: str(e.payload.detail),
          occurred_at: e.occurred_at,
        });
        break;
      case 'reg.contradiction_resolved': {
        const contradictionSeq = Number(e.payload.contradiction_seq);
        const kind = str(e.payload.kind);
        if (Number.isInteger(contradictionSeq) && kind) resolvedContradictions.add(`${contradictionSeq}:${kind}`);
        break;
      }
      default:
        break; // launch-chain rungs, sends' gated, dedupe — no projection effect here
    }
  }

  const currentBindings = [...bindingBySeat.values()];
  for (const binding of currentBindings) {
    if (!binding.instance_id) continue;
    const readyGeneration = readinessByInstance.get(binding.instance_id);
    binding.readiness = readyGeneration === binding.bound_seq ? 'ready' : 'unready';
    const route = routeByInstance.get(binding.instance_id);
    binding.routing = route?.generation === binding.bound_seq ? route.state : 'inactive';
    binding.route_closed_reason = binding.routing === 'active' ? null
      : route?.generation !== undefined && route.generation !== binding.bound_seq ? 'binding_generation_changed'
      : route?.reason ?? (binding.readiness === 'ready' ? 'route_not_activated' : 'readiness_not_attested');
  }

  const freelist: FreelistEntry[] = [];
  for (const [seat, pane] of paneBySeat) {
    if ((pane === 'live' || pane === 'empty') && !bindingBySeat.has(seat)) {
      freelist.push({ seat_id: seat, pane_state: pane });
    }
  }

  const activityBoard: ActivityBoardRow[] = [];
  for (const [seat, pane] of paneBySeat) {
    const binding = bindingBySeat.get(seat);
    const instanceId = binding?.instance_id ?? null;
    const entity_id = instanceId ?? seat;
    activityBoard.push({
      entity_id,
      entity_type: instanceId ? 'instance' : 'seat',
      seat_id: seat,
      pane,
      binding: binding ? 'bound' : 'unbound',
      activity: instanceId ? activityByInstance.get(instanceId) ?? 'idle' : 'idle',
      // Sends target the seat's canonical id.
      queue_depth: queueByTarget.get(seat) ?? 0,
      persona: binding?.persona ?? null,
      rank: binding?.rank ?? null,
      commander: binding?.commander ?? null,
      tint: binding?.tint ?? null,
      registration: binding ? 'registered' : 'unregistered',
      readiness: binding?.readiness ?? 'unready',
      routing: binding?.routing ?? 'inactive',
      placement: binding?.placement ?? null,
      route_closed_reason: binding?.route_closed_reason ?? 'unregistered',
      binding_generation: binding?.bound_seq ?? null,
    });
  }

  // A contradiction is OPEN unless a later event moved its entity (re-observe to
  // re-flag). Pure stream filter — no resolve event, no fourth table.
  const openContradictions = contradictions.filter((c) => !resolvedContradictions.has(`${c.seq}:${c.kind}`));

  // A close-on-stop subscription is OPEN until the FIRST stop_reported after it —
  // satiated-once. Derived, no fire/satiate event (the same fold pattern as every
  // other axis; no bespoke subscription state to drift).
  const openStopSubscriptions = new Set<string>();
  for (const [instance, subSeq] of subscribeSeqByInstance) {
    const stopSeq = lastStopSeqByInstance.get(instance);
    if (stopSeq === undefined || stopSeq < subSeq) openStopSubscriptions.add(instance);
  }

  return {
    currentBindings,
    freelist,
    activityBoard,
    openContradictions,
    activityByInstance,
    everBoundInstances,
    openStopSubscriptions,
  };
}
