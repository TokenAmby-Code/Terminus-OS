// Daemon core — the domain logic behind the API (spec §4, §5, §6).
//
// Single writer: every mutating path runs under one async mutex so seq order
// and read-modify-write sequences never interleave. Truth is the event stream;
// this class only APPENDS facts and READS projections — it never mutates a
// projection directly.

import {
  AGENT_SCHEMA_VERSION,
  AgentRetiredSchema,
  UnregisteredClosedSchema,
  PLACEMENT_REFUSAL_REASONS,
  PlacementRefusedSchema,
  RegistrationAbortedSchema,
  SCHEMA_VERSION,
  type RegistrationAborted,
  type ActivityBoardRow,
  CLOSE_REQUIRED_RANK,
  type CloseRequest,
  type CloseResponse,
  type CloseVerdict,
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
  DispatchAttestedSchema,
  DispatchRefusedSchema,
  type DispatchRefused,
  type DispatchRequested,
  type SeatDisqualifier,
  type EventInput,
  type Health,
  type EstateRotateRequest,
  type EstateRotateResponse,
  type LaunchRequest,
  type LaunchResponse,
  type ModeTransitionRequest,
  type ModeTransitionResponse,
  type OpenContradiction,
  PaneAttestedSchema,
  PaneRefusedSchema,
  PhysicalDeclarationSchema,
  PlacementAttestedSchema,
  AgentSchema,
  type Agent,
  type PhysicalDeclaration,
  type Provenance,
  type ProvenanceSource,
  type ReconcileResponse,
  type RetirementCause,
  type StopReceipt,
  type StopRefusal,
  type StopRefusalReason,
  type StopRequest,
  type TmuxLifecycleEventRequest,
  type TmuxLifecycleEventResponse,
  type TintReadiness,
  type WrapperStartHook,
  CLIPBOARD_BUFFER_NAME,
  MAX_CLIPBOARD_BYTES,
} from '@terminus-os/contracts';
import { createHash } from 'node:crypto';
import type { EventStore } from './store.ts';
import { findTmuxId } from './ids.ts';
import { buildProjections, type Projections, type LaunchComposition, type TransportClaim } from './projections.ts';
import { DECOMMISSIONED_COUNCIL_SEATS, EMPEROR_SEAT, isTxdPage, SSH_SEAT_TARGETS, sshSeatTarget, TXD_ESTATE, TXD_WINDOWS, type TxdPage } from './estate.ts';
import { ENVELOPE_PREFIX, envelopeSessionName, type RemoteEnvelopeLister } from './envelopes.ts';
import { NOOP_ROTATION_BARRIER, type EstateRotationBarrier } from './rotation-lock.ts';
import type { TmuxControlPlane } from './tmux.ts';
import type { TxdPublishedEventType } from './events.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const DOOR1_REQUIRED_ATTESTATIONS = ['identity', 'persona', 'tint'] as const;

type Now = () => string;
export type PhysicalRegistrationRuntime = {
  machine: string;
  configuration: { generation: string; digest: string };
  agentWrapper: string;
  perpetual: Record<string, 'claude' | 'codex'>;
  publish: (
    eventType: TxdPublishedEventType,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
};

const COUNCIL_MIGRATION_ID = 'council-four-seat-layout';

// A persona name addresses one agent only while one agent wears it. Several
// agents may share a worker persona at once, so the caller is told the two
// identities that always resolve to exactly one seat.
const AMBIGUOUS_IDENTITY = (identity: string): string =>
  `identity_ambiguous: ${identity} — address one agent by AGENT_ID or seat id`;

// txd's own answer to "which seat may hold which persona". Derived from the
// estate declaration, not from anything an asserting service sends: a council
// seat's canonical id names the one persona it may hold, and every other seat
// names nobody. tmux attests the canonical id, so this is checkable against the
// physical estate.
const COUNCIL_SEAT_PERSONAS = new Map<string, string>(
  TXD_WINDOWS.council.map((seatId) => [seatId, seatId.slice(seatId.indexOf(':') + 1)]),
);
const COUNCIL_PERSONAS = new Set(COUNCIL_SEAT_PERSONAS.values());

// The wrapper's transport claim, read from wrapper_start placement hints as
// dumb strings. Anything malformed folds to a local claim with no facts —
// Door 1 then refuses it on an ssh seat, loudly.
function transportClaimFromHints(hints: Record<string, unknown>): Omit<TransportClaim, 'seat_id' | 'pane_generation'> {
  const field = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  return {
    kind: hints.kind === 'ssh' ? 'ssh' : 'local',
    target_machine: field(hints.target_machine),
    launch_nonce: field(hints.launch_nonce),
    envelope_session: field(hints.envelope_session),
  };
}

function liveComposition(
  composition: LaunchComposition | undefined,
  paneGeneration: string,
): LaunchComposition | undefined {
  return composition && composition.pane_generation === paneGeneration ? composition : undefined;
}

function liveClaim(
  claim: TransportClaim | undefined,
  paneGeneration: string,
): TransportClaim | undefined {
  return claim && claim.pane_generation === paneGeneration ? claim : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class Daemon {
  private mutex: Promise<unknown> = Promise.resolve();
  private commWaiters = new Map<string, Set<() => void>>();

  constructor(
    private store: EventStore,
    private tmux: TmuxControlPlane,
    private now: Now = () => new Date().toISOString(),
    private rotationBarrier: EstateRotationBarrier = NOOP_ROTATION_BARRIER,
    private physicalRegistration: PhysicalRegistrationRuntime | null = null,
    private remoteEnvelopes: RemoteEnvelopeLister | null = null,
  ) {}

  async attestWrapperStart(
    hook: WrapperStartHook,
  ): Promise<{ attested: boolean; reason: string | null }> {
    return this.locked(async () => {
      if (!this.physicalRegistration) {
        return { attested: false, reason: 'physical_registration_unconfigured' };
      }
      const observed = await this.tmux.attestWrapperPlacement(hook.wrapper_pid);
      if (!observed.ok) {
        const refusal = PaneRefusedSchema.parse({
          hook_request_id: hook.hook_request_id,
          claimed_pane_id: hook.claimed_pane_id,
          machine: this.physicalRegistration.machine,
          wrapper_pid: hook.wrapper_pid,
          reason: observed.reason,
        });
        await this.physicalRegistration.publish('agent.pane_refused', refusal);
        return { attested: false, reason: observed.reason };
      }
      // The transport claim is recorded as the wrapper asserted it and audited
      // at Door 1 against the launch composition; recording is not belief.
      const claim = transportClaimFromHints(hook.placement_hints);
      await this.store.append({
        entity_type: 'seat',
        entity_id: observed.pane_id,
        event_type: 'reg.transport_claimed',
        payload: {
          seat_id: observed.pane_id,
          pane_generation: observed.pane_generation,
          kind: claim.kind,
          target_machine: claim.target_machine,
          launch_nonce: claim.launch_nonce,
          envelope_session: claim.envelope_session,
        },
        provenance: this.prov('wrapper', null),
        occurred_at: this.now(),
      });
      const projections = await this.projections();
      const composition = liveComposition(projections.launchCompositions.get(observed.pane_id), observed.pane_generation);
      const attestation = PaneAttestedSchema.parse({
        hook_request_id: hook.hook_request_id,
        claimed_pane_id: hook.claimed_pane_id,
        pane_id: observed.pane_id,
        pane_generation: observed.pane_generation,
        machine: this.physicalRegistration.machine,
        kind: sshSeatTarget(observed.pane_id) ? 'ssh' : 'local',
        agent_id: composition?.agent_id ?? null,
        wrapper_pid: hook.wrapper_pid,
        configuration: this.physicalRegistration.configuration,
        process_witnesses: {
          pane_root_pid: observed.pane_root_pid,
          ancestry: observed.ancestry,
          process_start_ticks: observed.process_start_ticks,
        },
      });
      await this.physicalRegistration.publish('agent.pane_attested', attestation);
      return { attested: true, reason: null };
    });
  }

  /**
   * Seat resolution for a dispatch. registrationd owns who an agent becomes;
   * txd owns where it sits. A page target gets whichever seat on the page is
   * free; a seat target gets exactly that seat or a seat-level refusal. The
   * seat is started with the sanctioned wrapper and the birth proceeds from
   * the wrapper's own hook.
   */
  dispatch(request: DispatchRequested): Promise<void> {
    return this.locked(async () => {
      if (!this.physicalRegistration) throw new Error('physical_registration_unconfigured');
      const publish = this.physicalRegistration.publish;
      const machine = this.physicalRegistration.machine;
      const refuse = (reason: DispatchRefused['reason'], seats: DispatchRefused['seats'] = []) => publish(
        'agent.dispatch_refused',
        DispatchRefusedSchema.parse({
          schema_version: request.schema_version,
          dispatch_id: request.dispatch_id,
          machine,
          target: request.target,
          engine: request.engine,
          reason,
          seats,
        }),
      );
      const events = await this.store.readAll();
      const pendingResetSeats = this.pendingScopedResetSeats(events);
      const projections = buildProjections(events);
      const bound = new Set(projections.currentBindings.map((binding) => binding.seat_id));
      const paneBySeat = new Map(projections.activityBoard.map((row) => [row.seat_id, row.pane]));
      const workloads = new Map((await this.tmux.workloads()).map((row) => [row.seat_id, row]));
      // One candidate's seat-level truth, first disqualifier in a fixed order.
      const disqualify = (candidate: string): Exclude<SeatDisqualifier, 'foreign_process'> | null => {
        if (projections.decommissionedSeats.has(candidate)) return 'decommissioned';
        if (pendingResetSeats.has(candidate)) return 'reset_pending';
        if (bound.has(candidate)) return 'bound';
        const pane = paneBySeat.get(candidate);
        if (pane !== 'live' && pane !== 'empty') return 'dead';
        return null;
      };
      const idle = (candidate: string) => workloads.get(candidate)?.idle ?? false;
      let seatId: string;
      if (request.target.kind === 'page') {
        const page = request.target.page;
        if (!isTxdPage(page)) {
          await refuse('page_absent');
          return;
        }
        // Declared page order, so which seat an autofill takes is
        // reproducible. Autofill never displaces a foreign foreground
        // process: when txd itself is choosing, only an idle shell is free.
        const states = TXD_WINDOWS[page].map((candidate) => ({
          seat_id: candidate,
          state: disqualify(candidate) ?? (idle(candidate) ? null : 'foreign_process' as const),
        }));
        const chosen = states.find((candidate) => candidate.state === null);
        if (!chosen) {
          await refuse('no_free_seat', states.map((candidate) => ({
            seat_id: candidate.seat_id,
            state: candidate.state!,
          })));
          return;
        }
        seatId = chosen.seat_id;
      } else {
        // An explicitly named seat replaces whatever its pane is running —
        // naming the seat is the authorization, and the CLI's in-place
        // default resolves to the invoking pane, whose foreground is the
        // invoker itself. Only a live agent binding or estate-level state
        // refuses.
        seatId = request.target.seat_id;
        if (!TXD_ESTATE.includes(seatId)) {
          await refuse('seat_absent');
          return;
        }
        const state = disqualify(seatId);
        if (state !== null) {
          const reason = ({
            bound: 'seat_bound',
            decommissioned: 'seat_decommissioned',
            reset_pending: 'seat_reset_pending',
            dead: 'pane_dead',
          } as const)[state];
          await refuse(reason, [{ seat_id: seatId, state }]);
          return;
        }
      }
      const paneGeneration = await this.tmux.seatGeneration(seatId);
      if (!paneGeneration) {
        await refuse('seat_generation_unattested');
        return;
      }
      // Launch composition: identity (minted by registrationd at dispatch),
      // a fresh per-launch nonce, and — for an ssh seat — the declared target
      // alias all enter the pane environment here. The composition is
      // remembered against the pane generation so the placement adapter can
      // audit the wrapper's echo; a fresh birth on the same seat mints a
      // fresh nonce, so a new binding can never attach a dead generation's
      // envelope.
      const launchNonce = crypto.randomUUID();
      const sshTarget = sshSeatTarget(seatId);
      if (!(await this.tmux.startSeatEngine({
        seatId,
        engine: request.engine,
        wrapper: this.physicalRegistration.agentWrapper,
        agentId: request.agent_id,
        launchNonce,
        ...(sshTarget ? { sshTarget } : {}),
      }))) {
        await refuse('seat_start_failed');
        return;
      }
      await this.store.append({
        entity_type: 'seat',
        entity_id: seatId,
        event_type: 'reg.launch_composed',
        payload: {
          seat_id: seatId,
          pane_generation: paneGeneration,
          agent_id: request.agent_id,
          launch_nonce: launchNonce,
          target_machine: sshTarget ?? null,
          engine: request.engine,
        },
        provenance: this.prov('observer', null),
        occurred_at: this.now(),
      });
      await publish('agent.dispatch_attested', DispatchAttestedSchema.parse({
        schema_version: request.schema_version,
        dispatch_id: request.dispatch_id,
        machine,
        seat_id: seatId,
        pane_generation: paneGeneration,
        engine: request.engine,
      }));
    });
  }

  /**
   * The whole wrapper-placement phase in one serialized op: record the
   * declaration, bind the seat, paint the tint, and attest placement. The
   * declaration is the earliest moment placement is attested and the persona
   * assertion (including tint) is in hand, so the agent is bound and visible
   * before its engine takes a first turn.
   */
  recordPhysicalDeclaration(input: PhysicalDeclaration, receipt: string | null = null): Promise<void> {
    return this.locked(async () => {
      if (!this.physicalRegistration) throw new Error('physical_registration_unconfigured');
      const declaration = PhysicalDeclarationSchema.parse(input);
      try {
        await this.auditAndBindDeclaration(declaration, receipt);
      } catch (error) {
        // A Door-1 refusal is the placement's terminal outcome for this
        // birth: any partial binding was already aborted fail-dark, so the
        // refusal publishes as the evidence registrationd aborts the birth
        // on. Contradiction classes (conflicting evidence for one entity)
        // stay unpublished — they are audit faults, not placement outcomes.
        const reason = error instanceof Error ? error.message : String(error);
        if ((PLACEMENT_REFUSAL_REASONS as readonly string[]).includes(reason)) {
          await this.publishPlacementRefusal(declaration, reason);
        }
        throw error;
      }
    });
  }

  private async auditAndBindDeclaration(
    declaration: PhysicalDeclaration,
    receipt: string | null,
  ): Promise<void> {
    const physicalRegistration = this.physicalRegistration;
    if (!physicalRegistration) throw new Error('physical_registration_unconfigured');
    {
      if (declaration.configuration.generation !== physicalRegistration.configuration.generation
          || declaration.configuration.digest !== physicalRegistration.configuration.digest) {
        throw new Error('physical_configuration_skew');
      }
      const observed = await this.tmux.attestWrapperPlacement(declaration.wrapper_pid);
      if (!observed.ok
          || observed.pane_id !== declaration.pane_id
          || observed.pane_generation !== declaration.pane_generation) {
        throw new Error('physical_declaration_contradicted');
      }
      // Level-two coherence. The asserted persona is checked against the seat
      // tmux says the wrapper is in — never against the pane the declaration
      // claims, which is the thing under audit. A council persona belongs to
      // exactly one council seat, so asserting one into a worker seat, or into
      // another council seat, is incoherent whatever the asserting service
      // believes. A worker persona names no seat and is constrained by nothing
      // here — several agents may wear one at once.
      if (declaration.persona !== null && COUNCIL_PERSONAS.has(declaration.persona)
          && COUNCIL_SEAT_PERSONAS.get(observed.pane_id) !== declaration.persona) {
        throw new Error('persona_seat_incoherent');
      }
      let projections = await this.projections();
      // Seat-aware placement audit. The estate declares each seat's kind; the
      // wrapper's transport claim and txd's own launch composition must agree
      // with it before any binding stands. Remote start ticks are not
      // comparable across kernels and are never collected — the nonce echo
      // plus the transport is what guards the remote half.
      const seatTarget = sshSeatTarget(observed.pane_id);
      const claim = liveClaim(projections.transportClaims.get(observed.pane_id), observed.pane_generation);
      const composition = liveComposition(projections.launchCompositions.get(observed.pane_id), observed.pane_generation);
      if (seatTarget) {
        if (!claim || claim.kind !== 'ssh') throw new Error('placement_kind_incoherent');
        if (claim.target_machine !== seatTarget) throw new Error('placement_machine_incoherent');
        if (!composition
            || composition.agent_id !== declaration.agent_id
            || !claim.launch_nonce
            || claim.launch_nonce !== composition.launch_nonce) {
          throw new Error('launch_nonce_contradicted');
        }
      } else if (claim?.kind === 'ssh') {
        throw new Error('placement_kind_incoherent');
      }
      const existing = projections.physicalDeclarations.get(declaration.agent_id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(declaration)) {
        throw new Error('physical_declaration_conflict');
      }
      if (!existing) {
        if (projections.currentBindings.some((binding) =>
          binding.agent_id === declaration.agent_id || binding.seat_id === declaration.pane_id)) {
          throw new Error('physical_binding_conflict');
        }
        await this.store.append({
          entity_type: 'agent',
          entity_id: declaration.agent_id,
          event_type: 'reg.physical_declared',
          payload: declaration,
          provenance: this.prov('observer', receipt),
          occurred_at: this.now(),
        });
        projections = await this.projections();
      }
      let binding = projections.currentBindings.find(
        (candidate) => candidate.agent_id === declaration.agent_id,
      );
      if (binding?.birth_generation === declaration.birth_generation
          && projections.placementAttestedAgents.has(declaration.agent_id)) {
        return;
      }
      if (!binding) {
        const occupied = projections.currentBindings.some((candidate) =>
          candidate.seat_id === declaration.pane_id || candidate.agent_id === declaration.agent_id,
        );
        if (occupied) throw new Error('physical_binding_conflict');
        const provenance = this.prov('observer', receipt);
        const occurredAt = this.now();
        const prepareId = await this.prepareBinding(
          declaration.pane_id,
          declaration.pane_generation,
          {
            agent_id: declaration.agent_id,
            birth_generation: declaration.birth_generation,
            engine: declaration.engine,
            wrapper_pid: declaration.wrapper_pid,
            configuration_generation: declaration.configuration.generation,
            configuration_digest: declaration.configuration.digest,
            tint: declaration.tint,
          },
          provenance,
          occurredAt,
        );
        const tintApplied = declaration.tint === null
          ? await this.tmux.setSeatTint(declaration.pane_id, null)
          : await this.applyBindingTint(declaration.pane_id, declaration.tint);
        if (!tintApplied) {
          await this.abortBinding(
            declaration.pane_id,
            prepareId,
            'tint_attestation_failed',
            provenance,
          );
          throw new Error('tint_attestation_failed');
        }
        await this.store.append({
          entity_type: 'seat',
          entity_id: declaration.pane_id,
          event_type: 'reg.bound',
          payload: {
            agent_id: declaration.agent_id,
            birth_generation: declaration.birth_generation,
            persona: declaration.persona,
            rank: declaration.rank,
            commander: null,
            tint: declaration.tint,
            pane_generation: declaration.pane_generation,
            engine: declaration.engine,
            wrapper_pid: declaration.wrapper_pid,
            configuration_generation: declaration.configuration.generation,
            configuration_digest: declaration.configuration.digest,
            binding_prepare_id: prepareId,
          },
          provenance,
          occurred_at: occurredAt,
        });
        projections = await this.projections();
        binding = projections.currentBindings.find(
          (candidate) => candidate.agent_id === declaration.agent_id,
        );
      }
      if (!binding?.agent_id
          || !binding.wrapper_pid
          || !binding.configuration_generation
          || !binding.configuration_digest) {
        throw new Error('physical_binding_incomplete');
      }
      const placement = PlacementAttestedSchema.parse({
        schema_version: AGENT_SCHEMA_VERSION,
        agent_id: binding.agent_id,
        birth_generation: declaration.birth_generation,
        pane_id: binding.seat_id,
        pane_generation: binding.pane_generation,
        configuration: {
          generation: binding.configuration_generation,
          digest: binding.configuration_digest,
        },
        machine: seatTarget ?? physicalRegistration.machine,
        kind: seatTarget ? 'ssh' : 'local',
        wrapper_pid: binding.wrapper_pid,
        // The witnesses let a reader of the final record reconstruct why this
        // placement was believed. The nonce travels only as a digest — it is
        // correlation, not a credential, and the record must not become one.
        transport_witnesses: seatTarget && composition
          ? {
              physical_declared_receipt: receipt,
              wrapper_pid: binding.wrapper_pid,
              wrapper_start_ticks: observed.process_start_ticks[String(declaration.wrapper_pid)] ?? null,
              target_machine: seatTarget,
              launch_nonce_digest: sha256(composition.launch_nonce),
              envelope_session: claim?.envelope_session ?? envelopeSessionName(binding.seat_id, composition.launch_nonce),
            }
          : { physical_declared_receipt: receipt },
      });
      await physicalRegistration.publish('agent.placement_attested', placement);
      await this.store.append({
        entity_type: 'agent',
        entity_id: binding.agent_id,
        event_type: 'reg.placement_attested',
        payload: { birth_generation: declaration.birth_generation },
        provenance: this.prov('observer', receipt),
        occurred_at: this.now(),
      });
    }
  }

  private async publishPlacementRefusal(declaration: PhysicalDeclaration, reason: string): Promise<void> {
    if (!this.physicalRegistration) return;
    const refusal = PlacementRefusedSchema.safeParse({
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: declaration.agent_id,
      birth_generation: declaration.birth_generation,
      pane_id: declaration.pane_id,
      pane_generation: declaration.pane_generation,
      machine: this.physicalRegistration.machine,
      reason,
      refused_at: this.now(),
    });
    if (!refusal.success) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'placement_refused_publish_skipped',
        agent_id: declaration.agent_id,
        reason,
      }));
      return;
    }
    try {
      await this.physicalRegistration.publish('agent.placement_refused', refusal.data);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'placement_refused_publish_failed',
        agent_id: declaration.agent_id,
        reason,
        error: String(error),
      }));
    }
  }

  // The abort-path close (chapter-locks spec §4): registrationd aborted its
  // partial birth and the single registration-abort event carries the whole
  // cleanup story, so txd closes whatever binding still stands for that
  // birth. Convergent by construction — a replay finds nothing standing and
  // changes nothing. Never a retirement: the registered guard refuses loud,
  // and executeClose's publication gate keeps agent.retired off the bus for
  // a never-registered binding.
  abortRegistration(input: RegistrationAborted, transportReceipt: string | null = null): Promise<void> {
    return this.locked(async () => {
      const abort = RegistrationAbortedSchema.parse(input);
      const projections = await this.projections();
      const binding = projections.currentBindings.find(
        (candidate) => candidate.agent_id === abort.agent_id,
      );
      if (!binding || binding.birth_generation !== abort.birth_generation) {
        console.log(JSON.stringify({
          level: 'info',
          event: 'registration_abort_already_clear',
          agent_id: abort.agent_id,
          birth_generation: abort.birth_generation,
          reason: abort.reason,
        }));
        return;
      }
      if (binding.registered) throw new Error('abort_of_registered_agent');
      if (!(await this.executeClose(binding, transportReceipt, false))) {
        throw new Error('abort_reap_failed');
      }
    });
  }

  activateRegisteredAgent(input: Agent): Promise<void> {
    return this.locked(async () => {
      const agent = AgentSchema.parse(input);
      if (!this.physicalRegistration) throw new Error('physical_registration_unconfigured');
      const projections = await this.projections();
      const binding = projections.currentBindings.find(
        (candidate) => candidate.agent_id === agent.agent_id,
      );
      if (!binding
          || binding.birth_generation !== agent.birth_generation
          || binding.seat_id !== agent.placement.pane_id
          || binding.pane_generation !== agent.placement.pane_generation
          || binding.wrapper_pid !== agent.placement.wrapper_pid
          || binding.engine !== agent.engine
          || binding.configuration_generation !== agent.configuration.generation
          || binding.configuration_digest !== agent.configuration.digest
          // Seat-aware: an ssh seat's registered placement names the seat's
          // configured target and kind 'ssh'; a local seat names this daemon's
          // machine and kind 'local'. Any other combination is a conflict.
          || agent.placement.machine !== (sshSeatTarget(binding.seat_id) ?? this.physicalRegistration.machine)
          || agent.placement.kind !== (sshSeatTarget(binding.seat_id) ? 'ssh' : 'local')
          || binding.tint !== (agent.persona?.tint ?? null)
          // The registered agent must be the agent txd signed off at bind time.
          // registrationd holds the persona authority; txd holds it to the
          // assertion it already attested rather than transcribing a new one.
          || binding.persona !== (agent.persona?.persona ?? null)
          || binding.rank !== (agent.persona?.rank ?? null)) {
        throw new Error('registered_agent_physical_conflict');
      }
      if (binding.registered) {
        // Persona and rank were attested at bind time and checked above; the
        // commander arrives with the registration itself.
        if (binding.commander !== (agent.persona?.commander ?? null)) {
          throw new Error('registered_agent_package_conflict');
        }
        return;
      }
      await this.store.append({
        entity_type: 'agent',
        entity_id: agent.agent_id,
        event_type: 'reg.agent_registered',
        payload: {
          birth_generation: agent.birth_generation,
          pane_id: agent.placement.pane_id,
          pane_generation: agent.placement.pane_generation,
          persona: agent.persona?.persona ?? null,
          rank: agent.persona?.rank ?? null,
          commander: agent.persona?.commander ?? null,
        },
        provenance: this.prov('observer', null),
        occurred_at: this.now(),
      });
    });
  }

  /**
   * On-demand zombie inventory: live envelopes on every declared ssh target,
   * joined against live bindings. An envelope whose nonce-bearing name no
   * live binding's launch composition accounts for is a zombie — alive after
   * its binding retired, holding no lock and no seat. Derived on demand,
   * never stored; reaping belongs to the sanctioned temporald ritual.
   */
  async zombieEnvelopes(): Promise<Array<{ target: string; session_name: string }>> {
    const lister = this.remoteEnvelopes;
    if (!lister) throw new Error('remote_envelope_lister_unconfigured');
    const projections = await this.projections();
    const expected = new Set<string>();
    for (const binding of projections.currentBindings) {
      if (!sshSeatTarget(binding.seat_id) || !binding.pane_generation) continue;
      const composition = liveComposition(
        projections.launchCompositions.get(binding.seat_id),
        binding.pane_generation,
      );
      if (composition) expected.add(envelopeSessionName(binding.seat_id, composition.launch_nonce));
    }
    const zombies: Array<{ target: string; session_name: string }> = [];
    for (const target of new Set(Object.values(SSH_SEAT_TARGETS))) {
      for (const session of await lister(target)) {
        if (!session.startsWith(ENVELOPE_PREFIX)) continue;
        if (!expected.has(session)) zombies.push({ target, session_name: session });
      }
    }
    return zombies;
  }

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
      await this.publishRetirements(bindings, 'estate_reset', occurred_at);
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
      b.registered
      && (b.agent_id === identity || b.persona === identity || b.seat_id === identity),
    );
    return matches.map((b) => ({ agent_id: b.agent_id!, seat_id: b.seat_id, persona: b.persona }));
  }

  comm(req: CommRequest, transportReceipt: string | null = null): Promise<CommAccepted> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      if (!proj.currentBindings.some((b) =>
        b.registered && b.agent_id === req.source_agent_id)) throw new Error('source_not_registered');
      const events = await this.store.readAll();
      let targetIdentity = req.target === '--self' ? req.source_agent_id : req.target;
      let replyingToAsk: string | null = null;
      if (req.reply) {
        const inbound = [...events].reverse().find((e) => e.event_type === 'reg.comm_accepted'
          && Array.isArray(e.payload.target_agent_ids)
          && e.payload.target_agent_ids.includes(req.source_agent_id));
        if (!inbound) throw new Error('no_recent_inbound_sender');
        targetIdentity = String(inbound.payload.source_agent_id);
        replyingToAsk = typeof inbound.payload.ask_id === 'string' ? inbound.payload.ask_id : null;
      }
      let targets: CommTarget[];
      if (req.page) {
        targets = proj.currentBindings
          .filter((b) => b.registered && b.seat_id.split(':', 1)[0] === req.page)
          .map((b) => ({ agent_id: b.agent_id!, seat_id: b.seat_id, persona: b.persona }));
        if (targets.length === 0) throw new Error(`page_absent: ${req.page}`);
      } else {
        targets = this.commTargets(targetIdentity!, proj);
        if (targets.length === 0) throw new Error(`identity_absent: ${targetIdentity}`);
        if (targets.length > 1) throw new Error(AMBIGUOUS_IDENTITY(targetIdentity!));
      }
      const pendingResetSeats = this.pendingScopedResetSeats(events);
      const fenced = targets.find((target) => pendingResetSeats.has(target.seat_id));
      if (fenced) throw new Error(`scoped_reset_pending: ${fenced.seat_id}`);
      const messageId = crypto.randomUUID();
      const askId = req.ask ? crypto.randomUUID() : null;
      const occurred_at = this.now();
      const accepted = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted', payload: {
        source_agent_id: req.source_agent_id, target_agent_ids: targets.map((t) => t.agent_id), targets,
        ask_id: askId, reply_to_ask_id: replyingToAsk, message: req.message,
      }, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      const snapshot = await this.store.append({ entity_type: askId ? 'ask' : 'message', entity_id: askId ?? messageId,
        event_type: 'reg.comm_target_snapshotted', payload: { message_id: messageId, targets }, provenance: this.prov('observer', transportReceipt), occurred_at });
      const event_ids = [accepted.seq, snapshot.seq];
      for (const target of targets) {
        const frame = `[tx comm ${messageId} from ${req.source_agent_id}${askId ? ` ask ${askId}` : ''}]\n${req.message}`;
        const sent = await this.tmux.sendToSeat(target.seat_id, frame);
        if (sent.verdict !== 'delivered') throw new Error(`transport_${sent.verdict}: ${target.agent_id}`);
        const event = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
          payload: { target_agent_id: target.agent_id, seat_id: target.seat_id, bytes: sent.bytes }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
        event_ids.push(event.seq);
      }
      if (replyingToAsk) await this.assertCallback(replyingToAsk, req.source_agent_id, req.message, 'reply', null, transportReceipt);
      return { ok: true, message_id: messageId, ask_id: askId, source_agent_id: req.source_agent_id, targets, bytes_sent: true, event_ids };
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
        binding.registered && (
          binding.agent_id === req.target
          || binding.persona === req.target
          || binding.seat_id === req.target
        ),
      );
      if (matches.length === 0) throw new Error(`identity_absent: ${req.target}`);
      if (matches.length > 1) throw new Error(AMBIGUOUS_IDENTITY(req.target));
      const binding = matches[0]!;
      if (!binding.agent_id || !binding.engine) {
        throw new Error(`engine_unattested: ${req.target}`);
      }
      const occurred_at = this.now();
      const requested = await this.store.append({
        entity_type: 'agent',
        entity_id: binding.agent_id,
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
        entity_type: 'agent',
        entity_id: binding.agent_id,
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
        agent_id: binding.agent_id,
        engine: binding.engine,
        intent: req.intent,
        trigger: req.trigger,
        ...outcome,
        event_ids: [requested.seq, terminal.seq],
        reason: outcome.verified ? null : 'transition_unverified',
      };
    });
  }

  private async assertCallback(askId: string, targetAgent: string, content: string, source: 'reply' | 'stop', stopEventId: string | null, receipt: string | null): Promise<void> {
    const events = await this.store.readAll();
    const snapshot = events.find((e) => e.entity_id === askId && e.event_type === 'reg.comm_target_snapshotted');
    const targets = (snapshot?.payload.targets ?? []) as CommTarget[];
    if (!targets.some((t) => t.agent_id === targetAgent)) return;
    if (events.some((e) => e.event_type === 'act.comm_callback_asserted' && e.payload.ask_id === askId && e.payload.target_agent_id === targetAgent)) return;
    const accepted = events.find((e) => e.entity_id === snapshot?.payload.message_id && e.event_type === 'reg.comm_accepted');
    const subscriber = String(accepted?.payload.source_agent_id ?? '');
    const assertionId = source === 'stop' ? `${stopEventId ?? 'stop'}:${subscriber}:${targetAgent}` : `${askId}:${targetAgent}`;
    if (events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_callback_asserted')) return;
    await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_callback_asserted',
      payload: { ask_id: askId, subscriber_agent_id: subscriber, target_agent_id: targetAgent, content, source, stop_event_id: stopEventId }, provenance: this.prov('observer', receipt), occurred_at: this.now() });
    this.wakeAsk(askId);
  }

  promptSubmitted(hook: CommHook, receipt: string | null = null): Promise<{ ok: true; asserted: boolean }> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const accepted = events.find((e) => e.entity_id === hook.message_id && e.event_type === 'reg.comm_accepted');
      if (!accepted || !(accepted.payload.target_agent_ids as unknown[]).includes(hook.agent_id)) throw new Error('message_target_mismatch');
      const assertionId = `${hook.message_id}:${hook.agent_id}`;
      if (events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_delivery_asserted')) return { ok: true, asserted: false };
      await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
        payload: { message_id: hook.message_id, target_agent_id: hook.agent_id, source_agent_id: accepted.payload.source_agent_id }, provenance: this.prov('hook', receipt), occurred_at: this.now() });
      const proj = await this.projections();
      const sender = proj.currentBindings.find((b) => b.agent_id === accepted.payload.source_agent_id);
      if (sender) await this.tmux.sendToSeat(sender.seat_id, `[tx comm delivery confirmed ${hook.message_id} target ${hook.agent_id}]`);
      return { ok: true, asserted: true };
    });
  }

  commStop(agentId: string, content: string, stopEventId: string | null, receipt: string | null): Promise<void> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const askIds = new Set(events
        .filter((e) => e.event_type === 'reg.comm_accepted' && typeof e.payload.ask_id === 'string')
        .map((e) => String(e.payload.ask_id)));
      const asks = events.filter((e) => e.event_type === 'reg.comm_target_snapshotted'
        && askIds.has(e.entity_id)
        && (e.payload.targets as CommTarget[]).some((t) => t.agent_id === agentId));
      for (const ask of asks) await this.assertCallback(ask.entity_id, agentId, content, 'stop', stopEventId, receipt);
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
      if (accepted?.payload.source_agent_id !== req.subscriber_agent_id) throw new Error('ask_subscriber_mismatch');
      const targetIds = new Set(targets.map((t) => t.agent_id));
      const callbacks: CommCallback[] = events.filter((e) => e.event_type === 'act.comm_callback_asserted' && (
        e.payload.ask_id === req.ask_id || (e.payload.source === 'stop' && e.payload.subscriber_agent_id === req.subscriber_agent_id && targetIds.has(String(e.payload.target_agent_id)))
      )).map((e) => ({
        target: targets.find((t) => t.agent_id === e.payload.target_agent_id)!, content: String(e.payload.content), assertion_event_id: e.seq, source: e.payload.source as 'reply' | 'stop',
      }));
      const done = new Set(callbacks.map((c) => c.target.agent_id));
      const outstanding = targets.filter((t) => !done.has(t.agent_id));
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

      // SCHEMA-level invariant (the agents.tmux_pane lesson): pin exact version.
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
      const seatBinding = proj.currentBindings.find((binding) => binding.seat_id === req.seat_id);
      if (seatBinding) {
        const exactRepeat = seatBinding.agent_id === req.identity
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
      const agentBinding = proj.currentBindings.find((binding) => binding.agent_id === req.identity);
      if (agentBinding) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `agent_already_bound: identity already has a current seat binding`,
        };
      }
      if (proj.activityByAgent.get(req.identity!) === 'retired') {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: 'agent_retired: retired identities cannot be rebound',
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
        agent_id: req.identity,
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
            agent_id: req.identity,
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
          if (binding.agent_id) {
            inputs.push({
              entity_type: 'agent',
              entity_id: binding.agent_id,
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
            payload: { agent_id: binding.agent_id },
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
        await this.publishRetirements(bindings, 'topology_migration', occurred_at);
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
          if (binding.pane_generation !== await this.tmux.seatGeneration(binding.seat_id)
            || await this.tmux.seatTint(binding.seat_id) !== binding.tint) {
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
      const bootRetiredAt = this.now();
      const bootRetirements = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, null, bootRetiredAt),
      );
      if (bootRetirements.length > 0) {
        await this.store.appendAll(bootRetirements);
        await this.publishRetirements(bindings, 'estate_reset', bootRetiredAt);
      }
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
    await this.provisionPerpetualAgents();
    return result;
  }

  // ── /agents/close — the sanctioned remote-close verb (rung 3) ──────────────
  // Reaps agent processes and returns their estate seats to the freelist. The
  // terminal chain (retired + process_reaped + seat_cleared) is atomic per seat
  // and only written AFTER that process is confirmed reaped — a retire-with-
  // live-process is unspellable (spec §4). Bulk is N independent single-seat
  // closes under one lock acquisition: each target gets its own verdict and its
  // own facts, a refused sibling never blocks a close, and a page is never
  // rebuilt. No silent no-op: an unbound target, a mid-turn agent (absent
  // force), the Emperor's seat, an underranked caller, or a failed reap all
  // refuse loud.
  close(req: CloseRequest, transportReceipt: string | null = null): Promise<CloseResponse> {
    return this.locked(async () => {
      const refused = (reason: string): CloseResponse => (
        { ok: false, closed_count: 0, refused_count: 0, verdicts: [], reason }
      );
      if (req.schema_version !== SCHEMA_VERSION) {
        return refused(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`);
      }

      const proj = await this.projections();
      const activityOf = (agentId: string | null): string =>
        (agentId ? proj.activityByAgent.get(agentId) ?? 'idle' : 'idle');

      // Closing is an overseer capability. The caller identity discipline is
      // comm's (source_agent_id must be a registered binding); the rank gate
      // reads the rank already recorded on that binding — no new auth scheme.
      const source = proj.currentBindings.find((b) => b.registered && b.agent_id === req.source_agent_id);
      if (!source) return refused('source_not_registered: source_agent_id resolves to no registered binding');
      if (source.rank !== CLOSE_REQUIRED_RANK) {
        return refused(`not_authorized: close requires rank ${CLOSE_REQUIRED_RANK}; source ${req.source_agent_id} holds rank ${source.rank ?? 'none'}`);
      }

      const verdicts: CloseVerdict[] = [];
      const closeOne = async (target: string, binding: CurrentBinding): Promise<void> => {
        // Reap FIRST; attest only on a confirmed kill (executeClose is the SAME
        // path the reflexive auto-close fires — one close mechanism, no bespoke
        // variant).
        const closed = await this.executeClose(binding, transportReceipt);
        verdicts.push({
          target,
          seat_id: binding.seat_id,
          agent_id: binding.agent_id,
          closed,
          reason: closed ? null : 'reap_failed: agent process could not be reaped; seat left bound (fail-loud, no half-close)',
        });
      };

      if (req.targets) {
        const closedSeats = new Set<string>();
        for (const target of req.targets) {
          const binding = proj.currentBindings.find(
            (b) => !closedSeats.has(b.seat_id) && (b.seat_id === target || b.agent_id === target),
          );
          if (target === EMPEROR_SEAT || binding?.seat_id === EMPEROR_SEAT) {
            // Hard refusal, force included: severing the operator is unspellable.
            verdicts.push({
              target,
              seat_id: binding?.seat_id ?? EMPEROR_SEAT,
              agent_id: binding?.agent_id ?? null,
              closed: false,
              reason: `palace_seat: ${EMPEROR_SEAT} is the Emperor's seat and is never closable`,
            });
            continue;
          }
          if (!binding) {
            // Refuse loud — closing a non-bound target is a no-op the caller
            // must see, never a silent success.
            verdicts.push({
              target,
              seat_id: null,
              agent_id: null,
              closed: false,
              reason: 'no_binding: target resolves to no current binding (already free or never bound)',
            });
            continue;
          }
          if (activityOf(binding.agent_id) === 'working' && !req.force) {
            // Graceful by default: a mid-turn close destroys work and strands
            // attestations. Idle-ness is the recorded activity fold, never a probe.
            verdicts.push({
              target,
              seat_id: binding.seat_id,
              agent_id: binding.agent_id,
              closed: false,
              reason: 'mid_turn: recorded activity is working; pass --force to close a hung agent',
            });
            continue;
          }
          await closeOne(target, binding);
          closedSeats.add(binding.seat_id);
        }
      } else {
        // Filtered selection is inherently graceful: recorded-idle (or stopped)
        // registered agents only — never an overseer, never the Emperor's seat,
        // never a mid-birth (unregistered) binding, whose death is registration
        // abort's story.
        const selected = proj.currentBindings.filter((b) => {
          if (!b.agent_id || !b.registered) return false;
          if (b.rank === CLOSE_REQUIRED_RANK || b.seat_id === EMPEROR_SEAT) return false;
          const activity = activityOf(b.agent_id);
          if (activity !== 'idle' && activity !== 'stopped') return false;
          return !req.page || b.seat_id.split(':', 1)[0] === req.page;
        });
        if (selected.length === 0) return refused('no_targets: selector matched no closable agent');
        for (const binding of selected) await closeOne(binding.agent_id!, binding);
      }

      const closedCount = verdicts.filter((v) => v.closed).length;
      return {
        ok: closedCount === verdicts.length && verdicts.length > 0,
        closed_count: closedCount,
        refused_count: verdicts.length - closedCount,
        verdicts,
        reason: null,
      };
    });
  }

  // Retirement publication (chapter-locks spec §4): every reg.retired append is
  // followed by `agent.retired` on the bus — the reactive leg of the retirement
  // authority split. The store facts are already committed when this runs, so a
  // bus refusal is reported loud and never un-closes the seat; a payload the
  // contract refuses (a non-registration launch identity) is skipped loud for
  // the same reason. Both are insurance gaps, not close failures.
  //
  // Retirement is a post-birth concept: a binding whose agent never registered
  // dies by registration abort instead, and registrationd can only abort on
  // evidence — the close-of-unregistered signal is that evidence. An abort-path
  // close (registrationd already terminalized the birth) sets signalUnregistered
  // false: there is no birth left to abort, so txd publishes nothing for it.
  private async publishRetirements(
    bindings: CurrentBinding[],
    cause: RetirementCause,
    retiredAt: string,
    signalUnregistered = true,
  ): Promise<void> {
    if (!this.physicalRegistration) return;
    for (const binding of bindings) {
      if (!binding.agent_id) continue;
      if (!binding.registered) {
        // Publishing agent.retired here would smuggle a birth failure into the
        // retirement stream consumers terminalize registered agents on; the
        // unregistered close travels on its own signal instead.
        if (signalUnregistered) await this.publishUnregisteredClose(binding, cause, retiredAt);
        continue;
      }
      const retirement = AgentRetiredSchema.safeParse({
        schema_version: AGENT_SCHEMA_VERSION,
        agent_id: binding.agent_id,
        birth_generation: binding.birth_generation,
        seat_id: binding.seat_id,
        pane_generation: binding.pane_generation,
        machine: this.physicalRegistration.machine,
        cause,
        retired_at: retiredAt,
      });
      if (!retirement.success) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'agent_retired_publish_skipped',
          agent_id: binding.agent_id,
          seat_id: binding.seat_id,
          cause,
          reason: retirement.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(','),
        }));
        continue;
      }
      try {
        await this.physicalRegistration.publish('agent.retired', retirement.data);
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'agent_retired_publish_failed',
          agent_id: binding.agent_id,
          seat_id: binding.seat_id,
          cause,
          error: String(error),
        }));
      }
    }
  }

  // The close-of-unregistered signal (chapter-locks lock-leak ruling): txd is
  // the only observer of a bound-but-unregistered seat's close, so it publishes
  // the evidence registrationd aborts the birth on — the abort's terminal row
  // is the chapter-lock release. A binding carrying no birth generation (the
  // launch door) identifies no birth and closes silently. Publication failure
  // is the same insurance gap as agent.retired: the store facts are committed,
  // the close stands, the gap is reported loud.
  private async publishUnregisteredClose(binding: CurrentBinding, cause: RetirementCause, closedAt: string): Promise<void> {
    if (!this.physicalRegistration || !binding.birth_generation) return;
    const signal = UnregisteredClosedSchema.safeParse({
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: binding.agent_id,
      birth_generation: binding.birth_generation,
      seat_id: binding.seat_id,
      pane_generation: binding.pane_generation,
      machine: this.physicalRegistration.machine,
      cause,
      closed_at: closedAt,
    });
    if (!signal.success) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'unregistered_closed_publish_skipped',
        agent_id: binding.agent_id,
        seat_id: binding.seat_id,
        cause,
        reason: signal.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(','),
      }));
      return;
    }
    try {
      await this.physicalRegistration.publish('agent.unregistered_closed', signal.data);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'unregistered_closed_publish_failed',
        agent_id: binding.agent_id,
        seat_id: binding.seat_id,
        cause,
        error: String(error),
      }));
    }
  }

  // The generic close mechanism, shared by /agents/close and the reflexive auto-close.
  // Reap-first, attest-after: respawn-pane -k keeps the estate pane (bare shell)
  // so the seat survives and returns to the freelist. On a confirmed reap, ONE
  // transaction writes retired + process_reaped + seat_cleared (seat_cleared frees
  // the binding — the ledger PROJECTION follows, no separate ledger to leak).
  // Returns false (nothing written) if the process could not be reaped, so a
  // retire-with-live-process is unspellable. Caller holds the single-writer mutex.
  private async executeClose(
    binding: CurrentBinding,
    transportReceipt: string | null,
    // False only on the abort-path close: registrationd already terminalized
    // the birth, so there is nothing left for a close-of-unregistered signal
    // to abort.
    signalUnregistered = true,
  ): Promise<boolean> {
    const reaped = await this.tmux.reapSeat(binding.seat_id, binding.tint);
    if (!reaped) return false;
    const occurred_at = this.now();
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.agent_id) {
      inputs.push({ entity_type: 'agent', entity_id: binding.agent_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    }
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { agent_id: binding.agent_id }, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_cleared', payload: {}, provenance: prov, occurred_at });
    await this.store.appendAll(inputs);
    await this.publishRetirements([binding], 'close', occurred_at, signalUnregistered);
    const perpetualEngine = this.physicalRegistration?.perpetual[binding.seat_id];
    if (perpetualEngine && !(await this.tmux.startSeatEngine({
      seatId: binding.seat_id,
      engine: perpetualEngine,
      wrapper: this.physicalRegistration!.agentWrapper,
      launchNonce: crypto.randomUUID(),
    }))) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'perpetual_relaunch_failed',
        seat_id: binding.seat_id,
      }));
    }
    return true;
  }

  // ── stop ingestion — the stop-hook's door (rung 3; delivered via /ingress/bus) ─────────────
  // Three honest outcomes, no blind swallow: record a fresh stop (bound + live),
  // dedupe a repeat/late stop (act.receipt_deduped), or REFUSE a ghost — a stop for
  // an id that never walked through /agents/launch. The ghost is refused at
  // admission, so nothing is recorded. The stop-hook is a REAL but UNTRUSTED
  // witness; what other services do with a stop is their correlation, consumed
  // from the bus — txd only folds the activity axis.
  stop(req: StopRequest, transportReceipt: string | null = null): Promise<StopReceipt | StopRefusal> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        return this.refuseStop('schema_version_mismatch', req.agent_id);
      }

      const proj = await this.projections();
      // Ghost preclusion: never bound ⇒ never existed ⇒ refuse loud.
      if (!proj.everBoundAgents.has(req.agent_id)) {
        return this.refuseStop('no_such_agent', req.agent_id);
      }

      const activity = proj.activityByAgent.get(req.agent_id) ?? null;
      const stillBound = proj.currentBindings.some((b) => b.agent_id === req.agent_id);
      // Dedupe: already stopped/retired, or already closed (no longer bound) →
      // idempotent, but RECORDED as receipt_deduped (never a blind swallow).
      if (activity === 'stopped' || activity === 'retired' || !stillBound) {
        await this.store.append({
          entity_type: 'agent',
          entity_id: req.agent_id,
          event_type: 'act.receipt_deduped',
          payload: { of: 'stop_reported', reason: activity ?? 'unbound' },
          provenance: this.prov('observer', transportReceipt),
          occurred_at: this.now(),
        });
        return { ok: true, agent_id: req.agent_id, recorded: false, deduped: true, activity };
      }

      // Fresh stop for a live, bound agent → record it (activity → stopped).
      await this.store.append({
        entity_type: 'agent',
        entity_id: req.agent_id,
        event_type: 'act.stop_reported',
        payload: {},
        provenance: this.prov('hook', transportReceipt),
        occurred_at: this.now(),
      });

      return { ok: true, agent_id: req.agent_id, recorded: true, deduped: false, activity: 'stopped' };
    });
  }

  private refuseStop(reason: StopRefusalReason, agentId: string): StopRefusal {
    const logged = findTmuxId(agentId) ? '<redacted-tmux-id>' : agentId;
    console.error(JSON.stringify({ level: 'error', event: 'stop_refused', reason, agent_id: logged }));
    return { ok: false, refused: true, reason, agent_id: agentId };
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

      // Retired agent whose pane is still live (retire-with-live-process).
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
        agents: proj.activityBoard.length,
        new_contradictions: newContradictions,
        open_contradictions: openContradictions,
        p0,
      };
    });
    if (councilRebuilt) await this.provisionPerpetualAgents();
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

  async provisionPerpetualAgents(): Promise<void> {
    if (!this.physicalRegistration) return;
    return this.locked(async () => {
      const projections = await this.projections();
      const workloads = new Map((await this.tmux.workloads()).map((row) => [row.seat_id, row]));
      for (const [seatId, engine] of Object.entries(this.physicalRegistration!.perpetual)) {
        if (!TXD_ESTATE.includes(seatId)) {
          throw new Error(`perpetual pane is outside the canonical estate: ${seatId}`);
        }
        if (projections.currentBindings.some((binding) => binding.seat_id === seatId)) continue;
        const workload = workloads.get(seatId);
        if (workload && !workload.idle) continue;
        if (!(await this.tmux.startSeatEngine({
          seatId,
          engine,
          wrapper: this.physicalRegistration!.agentWrapper,
          launchNonce: crypto.randomUUID(),
        }))) throw new Error(`perpetual launch failed: ${seatId}`);
      }
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
    if (result.ok) await this.provisionPerpetualAgents();
    return result;
  }

  private async resetEstateScopeUnlocked(
    req: EstateRotateRequest,
    transportReceipt: string | null,
    trigger: 'operator' | 'pane-died' | 'pane-exited' | 'pane-killed' = 'operator',
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
      await this.publishRetirements(bindings, 'estate_reset', completedAt);
    return { ok: true, rotation_id, accepted: true, force: req.force, scope, seats, bound_seats, foreground_workloads, reason: null };
  }

  async handleTmuxLifecycleEvent(
    req: TmuxLifecycleEventRequest,
    transportReceipt: string | null = null,
  ): Promise<TmuxLifecycleEventResponse> {
    const result = await this.locked(async () => {
      const page = req.page ?? null;
      const refused = (reason: string): TmuxLifecycleEventResponse => ({
        ok: false, event: req.event, page, reconstructed: false, reset_seats: [], rotation_ids: [], reason,
      });
      if (req.schema_version !== SCHEMA_VERSION) return refused('schema_version_mismatch');
      // A process-death hook fires in the dying pane's own context, so its
      // page claim scopes the observation. A kill command's hook context is
      // the active window — no page claim survives it — so `pane-killed`
      // sweeps every canonical page for the damage in one estate read.
      let pages: TxdPage[];
      if (req.event === 'pane-killed') {
        pages = Object.keys(TXD_WINDOWS) as TxdPage[];
      } else if (isTxdPage(req.page!)) {
        pages = [req.page as TxdPage];
      } else {
        return refused('page_absent');
      }
      const observed = await this.tmux.listSeats();
      const reset_seats: string[] = [];
      const rotation_ids: string[] = [];
      let ok = true;
      let reconstructed = false;
      let reason: string | null = null;
      let faultedPages = 0;
      for (const target of pages) {
        const expected = [...TXD_WINDOWS[target]];
        const pageObserved = observed.filter((seat) => seat.seat_id.startsWith(`${target}:`));
        const dead = new Set(expected.filter((seat) => pageObserved.some((o) => o.seat_id === seat && o.pane === 'dead')));
        const missing = new Set(expected.filter((seat) => !pageObserved.some((o) => o.seat_id === seat)));
        const faulted = expected.filter((seat) => dead.has(seat) || missing.has(seat));
        if (faulted.length === 0) continue;
        faultedPages += 1;
        // Fault scope is the pane. A dead pane is one faulted PROCESS whose
        // remain-on-exit corpse is the respawn target; a missing pane is one
        // killed TERMINAL whose surviving siblings anchor an in-place repair.
        // Either way the seat retires loudly and alone — siblings, which
        // carry no fault, are never touched. Only a page with no tagged pane
        // left has nothing to anchor a repair to; that class alone earns the
        // border-total page rebuild, and by then there is nobody left on the
        // page for the rebuild to sacrifice.
        if (pageObserved.length === 0) {
          const reset = await this.resetEstateScopeUnlocked(
            { schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: target },
            transportReceipt,
            req.event,
          );
          if (reset.rotation_id !== null) rotation_ids.push(reset.rotation_id);
          if (reset.accepted) reconstructed = true;
          if (reset.ok) {
            reset_seats.push(...reset.seats);
          } else {
            ok = false;
            reason = reset.reason;
          }
          continue;
        }
        for (const seat of faulted) {
          const reset = await this.resetEstateScopeUnlocked(
            { schema_version: SCHEMA_VERSION, force: true, scope: 'pane', pane: seat },
            transportReceipt,
            req.event,
          );
          if (reset.rotation_id !== null) rotation_ids.push(reset.rotation_id);
          if (reset.accepted) reconstructed = true;
          if (reset.ok) {
            reset_seats.push(seat);
          } else {
            // The durable request stays open; reconstruction recovery resumes
            // it. One seat's physical failure never blocks a sibling's repair.
            ok = false;
            reason = reset.reason;
          }
        }
      }
      if (faultedPages === 0) {
        return {
          ok: true, event: req.event, page, reconstructed: false, reset_seats: [], rotation_ids: [],
          reason: page === null ? 'estate_already_canonical' : 'page_already_canonical',
        };
      }
      return { ok, event: req.event, page, reconstructed, reset_seats, rotation_ids, reason };
    });
    if (result.ok && result.reconstructed) await this.provisionPerpetualAgents();
    return result;
  }

  private resetBindingInputs(
    binding: CurrentBinding,
    transportReceipt: string | null,
    occurred_at: string,
  ): EventInput[] {
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.agent_id) inputs.push({ entity_type: 'agent', entity_id: binding.agent_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { agent_id: binding.agent_id }, provenance: prov, occurred_at });
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
    const tints = await this.tintReadiness();
    return {
      ok: open === 0
        && tmux_reachable
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
      tints,
    };
  }
}

export type { EventInput };
