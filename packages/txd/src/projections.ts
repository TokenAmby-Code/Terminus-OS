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
//   act.prompt_submitted(agent) turn → 'working'
//   act.stop_reported  (agent) turn → 'awaiting_input'
//   reg.retired        (agent) turn → 'retired'
//   reg.contradiction_flagged     open unless a later event exists on the same entity_id

import { PANE_STATES, PhysicalDeclarationSchema, WorktreeBindingSchema } from '@terminus-os/contracts';
import type {
  SeatBoardRow,
  TurnState,
  CurrentBinding,
  EventRecord,
  FreelistEntry,
  OpenContradiction,
  PaneState,
  PhysicalDeclaration,
  WorktreeBinding,
} from '@terminus-os/contracts';

export type Projections = {
  currentBindings: CurrentBinding[];
  freelist: FreelistEntry[];
  seatBoard: SeatBoardRow[];
  openContradictions: OpenContradiction[];
  // Per-agent TURN fold (working|awaiting_input|unobserved|retired). It says
  // nothing about liveness: nothing here observes a process. Exposed so the
  // stop-ingestion door can dedupe (already-stopped/retired) without re-reading.
  turnByAgent: Map<string, TurnState>;
  // Every agent id that EVER carried a reg.bound — the "did it walk through
  // the door?" oracle. A stop for an id absent here is a ghost (never bound).
  everBoundAgents: Set<string>;
  physicalDeclarations: Map<string, PhysicalDeclaration>;
  placementAttestedAgents: Set<string>;
  decommissionedSeats: Set<string>;
  // Latest launch composition per seat: the identity, nonce, and target txd
  // set on the pane environment at dispatch. The nonce is the cross-kernel
  // correlation an ssh wrapper must echo before its placement is believed.
  launchCompositions: Map<string, LaunchComposition>;
  // Latest wrapper transport claim per seat, recorded at pane attestation and
  // audited at Door 1 against the launch composition.
  transportClaims: Map<string, TransportClaim>;
};

export type LaunchComposition = {
  seat_id: string;
  pane_generation: string;
  agent_id: string;
  launch_nonce: string;
  target_machine: string | null;
  worktree: WorktreeBinding | null;
};

export type TransportClaim = {
  seat_id: string;
  pane_generation: string;
  kind: 'local' | 'ssh';
  target_machine: string | null;
  launch_nonce: string | null;
  envelope_session: string | null;
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
  const placementAttestedAgents = new Set<string>();
  const turnByAgent = new Map<string, TurnState>();
  const everBoundAgents = new Set<string>();
  // (entity_type, entity_id) -> highest seq seen, to supersede stale contradiction
  // flags. Composite so a later event on a different entity type sharing an id can
  // never suppress the wrong entity's open contradiction.
  const lastSeqByEntity = new Map<string, number>();
  const entityKey = (type: string, id: string): string => `${type}\x00${id}`;
  const contradictions: OpenContradiction[] = [];
  const decommissionedSeats = new Set<string>();
  const launchCompositions = new Map<string, LaunchComposition>();
  const transportClaims = new Map<string, TransportClaim>();

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
          configuration_generation: str(e.payload.configuration_generation),
          configuration_digest: str(e.payload.configuration_digest),
          bound_seq: e.seq,
        });
        break;
      case 'reg.launch_composed': {
        const paneGeneration = str(e.payload.pane_generation);
        const agentId = str(e.payload.agent_id);
        const nonce = str(e.payload.launch_nonce);
        if (paneGeneration && agentId && nonce) {
          const worktree = WorktreeBindingSchema.safeParse(e.payload.worktree);
          launchCompositions.set(e.entity_id, {
            seat_id: e.entity_id,
            pane_generation: paneGeneration,
            agent_id: agentId,
            launch_nonce: nonce,
            target_machine: str(e.payload.target_machine),
            worktree: worktree.success ? worktree.data : null,
          });
        }
        break;
      }
      case 'reg.transport_claimed': {
        const paneGeneration = str(e.payload.pane_generation);
        const kind = e.payload.kind === 'ssh' ? 'ssh' : 'local';
        if (paneGeneration) {
          transportClaims.set(e.entity_id, {
            seat_id: e.entity_id,
            pane_generation: paneGeneration,
            kind,
            target_machine: str(e.payload.target_machine),
            launch_nonce: str(e.payload.launch_nonce),
            envelope_session: str(e.payload.envelope_session),
          });
        }
        break;
      }
      case 'reg.physical_declared': {
        const declaration = PhysicalDeclarationSchema.safeParse(e.payload);
        if (declaration.success) {
          physicalDeclarations.set(declaration.data.agent_id, declaration.data);
        }
        break;
      }
      case 'reg.placement_attested':
        placementAttestedAgents.add(e.entity_id);
        break;
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
        launchCompositions.delete(e.entity_id);
        transportClaims.delete(e.entity_id);
        break;
      case 'estate.scoped_reset_completed':
        if (Array.isArray(e.payload.seats)) {
          for (const seat of e.payload.seats) {
            if (typeof seat !== 'string') continue;
            launchCompositions.delete(seat);
            transportClaims.delete(seat);
          }
        }
        break;
      case 'reg.seat_decommissioned':
        decommissionedSeats.add(e.entity_id);
        paneBySeat.delete(e.entity_id);
        bindingBySeat.delete(e.entity_id);
        break;
      case 'act.prompt_submitted':
        turnByAgent.set(e.entity_id, 'working');
        break;
      case 'act.stop_reported':
        turnByAgent.set(e.entity_id, 'awaiting_input');
        break;
      case 'reg.retired':
        turnByAgent.set(e.entity_id, 'retired');
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

  const seatBoard: SeatBoardRow[] = [];
  for (const [seat, pane] of paneBySeat) {
    const binding = bindingBySeat.get(seat);
    const agentId = binding?.agent_id ?? null;
    const entity_id = agentId ?? seat;
    seatBoard.push({
      entity_id,
      entity_type: agentId ? 'agent' : 'seat',
      seat_id: seat,
      pane,
      binding: binding ? 'bound' : 'unbound',
      turn: agentId ? turnByAgent.get(agentId) ?? 'unobserved' : 'unobserved',
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

  return {
    currentBindings,
    freelist,
    seatBoard,
    openContradictions,
    turnByAgent,
    everBoundAgents,
    physicalDeclarations,
    placementAttestedAgents,
    decommissionedSeats,
    launchCompositions,
    transportClaims,
  };
}
