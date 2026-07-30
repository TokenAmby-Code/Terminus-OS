// Projections (spec §10) — the three day-one read models, ALL rebuilt purely by
// replay. Nobody writes them; they are a fold over the event stream. Open
// contradictions get NO table — "currently contradicted" is a stream filter.
//
// Payload conventions (dumb facts; the fold denormalizes on the read side):
//   reg.pane_created   (seat)     payload.pane_state? = 'live' | 'empty'   (default 'live')
//   reg.bound          (seat)     payload {agent_id, tint, pane_generation} — bound_seq = event.seq
//   reg.seat_cleared   (seat)     clears the binding (pane axis untouched)
//   reg.teardown_started(seat)    pane → 'dead' (teardown kills the pane)
//   reg.process_reaped (seat)     pane → 'dead'
//   act.prompt_submitted(agent) activity → 'working'
//   act.stop_reported  (agent) activity → 'stopped'
//   reg.retired        (agent) activity → 'retired'
//   reg.contradiction_flagged     open unless a later event exists on the same entity_id

import { PANE_STATES, PhysicalDeclarationSchema } from '@terminus-os/contracts';
import type {
  ActivityBoardRow,
  ActivityState,
  CurrentBinding,
  EventRecord,
  FreelistEntry,
  OpenContradiction,
  PaneState,
  PhysicalDeclaration,
} from '@terminus-os/contracts';

export type Projections = {
  currentBindings: CurrentBinding[];
  freelist: FreelistEntry[];
  activityBoard: ActivityBoardRow[];
  openContradictions: OpenContradiction[];
  // Per-agent activity fold (working|idle|stopped|retired), exposed so the
  // stop-ingestion door can dedupe (already-stopped/retired) without re-reading.
  activityByAgent: Map<string, ActivityState>;
  // Every agent id that EVER carried a reg.bound — the "did it walk through
  // the door?" oracle. A stop for an id absent here is a ghost (never bound).
  everBoundAgents: Set<string>;
  // Agent ids with an OPEN close-on-stop subscription: a reg.stop_subscribed
  // whose next act.stop_reported has not yet folded (satiated-once). The stop
  // door reads this to fire the reflexive auto-close.
  openStopSubscriptions: Set<string>;
  physicalDeclarations: Map<string, PhysicalDeclaration>;
  decommissionedSeats: Set<string>;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
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
  const physicalDeclarations = new Map<string, PhysicalDeclaration>();
  const activityByAgent = new Map<string, ActivityState>();
  const everBoundAgents = new Set<string>();
  const subscribeSeqByAgent = new Map<string, number>(); // last reg.stop_subscribed seq
  const lastStopSeqByAgent = new Map<string, number>(); // last act.stop_reported seq
  // (entity_type, entity_id) -> highest seq seen, to supersede stale contradiction
  // flags. Composite so a later event on a different entity type sharing an id can
  // never suppress the wrong entity's open contradiction.
  const lastSeqByEntity = new Map<string, number>();
  const entityKey = (type: string, id: string): string => `${type}\x00${id}`;
  const contradictions: OpenContradiction[] = [];
  const decommissionedSeats = new Set<string>();

  for (const e of events) {
    lastSeqByEntity.set(entityKey(e.entity_type, e.entity_id), e.seq);
    switch (e.event_type) {
      case 'reg.pane_created':
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
        if (str(e.payload.agent_id)) everBoundAgents.add(str(e.payload.agent_id)!);
        bindingBySeat.set(e.entity_id, {
          seat_id: e.entity_id,
          agent_id: str(e.payload.agent_id),
          birth_generation: str(e.payload.birth_generation),
          registered: false,
          persona: str(e.payload.persona),
          rank: str(e.payload.rank),
          commander: str(e.payload.commander),
          tint: str(e.payload.tint),
          pane_generation: str(e.payload.pane_generation),
          engine: e.payload.engine === 'claude' || e.payload.engine === 'codex' ? e.payload.engine : null,
          wrapper_pid: positiveInt(e.payload.wrapper_pid),
          engine_pid: positiveInt(e.payload.engine_pid),
          engine_executable: str(e.payload.engine_executable),
          cwd: str(e.payload.cwd),
          configuration_generation: str(e.payload.configuration_generation),
          configuration_digest: str(e.payload.configuration_digest),
          bound_seq: e.seq,
        });
        break;
      case 'reg.physical_declared': {
        const declaration = PhysicalDeclarationSchema.parse(e.payload);
        physicalDeclarations.set(declaration.agent_id, declaration);
        break;
      }
      case 'reg.agent_registered': {
        const binding = [...bindingBySeat.values()].find(
          (candidate) => candidate.agent_id === e.entity_id,
        );
        if (binding) {
          binding.registered = true;
          binding.persona = str(e.payload.persona);
          binding.rank = str(e.payload.rank);
          binding.commander = str(e.payload.commander);
        }
        physicalDeclarations.delete(e.entity_id);
        break;
      }
      case 'reg.seat_cleared':
        bindingBySeat.delete(e.entity_id);
        break;
      case 'reg.seat_decommissioned':
        decommissionedSeats.add(e.entity_id);
        paneBySeat.delete(e.entity_id);
        bindingBySeat.delete(e.entity_id);
        break;
      case 'act.prompt_submitted':
        activityByAgent.set(e.entity_id, 'working');
        break;
      case 'act.stop_reported':
        activityByAgent.set(e.entity_id, 'stopped');
        lastStopSeqByAgent.set(e.entity_id, e.seq);
        break;
      case 'reg.stop_subscribed':
        subscribeSeqByAgent.set(e.entity_id, e.seq);
        break;
      case 'reg.retired':
        activityByAgent.set(e.entity_id, 'retired');
        break;
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
      default:
        break; // launch-chain rungs, dedupe — no projection effect here
    }
  }

  const currentBindings = [...bindingBySeat.values()];

  const freelist: FreelistEntry[] = [];
  for (const [seat, pane] of paneBySeat) {
    if ((pane === 'live' || pane === 'empty') && !bindingBySeat.has(seat)) {
      freelist.push({ seat_id: seat, pane_state: pane });
    }
  }

  const activityBoard: ActivityBoardRow[] = [];
  for (const [seat, pane] of paneBySeat) {
    const binding = bindingBySeat.get(seat);
    const agentId = binding?.agent_id ?? null;
    const entity_id = agentId ?? seat;
    activityBoard.push({
      entity_id,
      entity_type: agentId ? 'agent' : 'seat',
      seat_id: seat,
      pane,
      binding: binding ? 'bound' : 'unbound',
      activity: agentId ? activityByAgent.get(agentId) ?? 'idle' : 'idle',
      persona: binding?.persona ?? null,
      rank: binding?.rank ?? null,
      commander: binding?.commander ?? null,
      tint: binding?.tint ?? null,
    });
  }

  // A contradiction is OPEN unless a later event moved its entity (re-observe to
  // re-flag). Pure stream filter — no resolve event, no fourth table.
  const openContradictions = contradictions.filter(
    (c) => (lastSeqByEntity.get(entityKey(c.entity_type, c.entity_id)) ?? c.seq) <= c.seq,
  );

  // A close-on-stop subscription is OPEN until the FIRST stop_reported after it —
  // satiated-once. Derived, no fire/satiate event (the same fold pattern as every
  // other axis; no bespoke subscription state to drift).
  const openStopSubscriptions = new Set<string>();
  for (const [agent, subSeq] of subscribeSeqByAgent) {
    const stopSeq = lastStopSeqByAgent.get(agent);
    if (stopSeq === undefined || stopSeq < subSeq) openStopSubscriptions.add(agent);
  }

  return {
    currentBindings,
    freelist,
    activityBoard,
    openContradictions,
    activityByAgent,
    everBoundAgents,
    openStopSubscriptions,
    physicalDeclarations,
    decommissionedSeats,
  };
}
