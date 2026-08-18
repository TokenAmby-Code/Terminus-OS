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
  type SeatBoardRow,
  CLOSE_REQUIRED_RANK,
  type CloseRequest,
  type CloseResponse,
  type CloseVerdict,
  type ClipboardPullRequest,
  type ClipboardPushRequest,
  type ClipboardSelectionRequest,
  type CommAccepted,
  type CommCallback,
  type CommDeliveryReadResponse,
  COMM_DELIVERY_RECEIPT_TIMEOUT_MS,
  type CommHook,
  type CommIntent,
  type CommRequest,
  type CommReceiptWaitRequest,
  type CommReceipt,
  type CommRedriveRequest,
  type CommRedriveResponse,
  type CommRecoverRequest,
  type CommRecoverResponse,
  type CommTarget,
  type CommWaitRequest,
  type CommWaitResponse,
  type CurrentBinding,
  DispatchAttestedSchema,
  PerpetualSeatVacantSchema,
  DispatchRefusedSchema,
  type DispatchRefused,
  type DispatchRequested,
  type SeatDisqualifier,
  type EventInput,
  type Health,
  type EstateRotateRequest,
  type EstateRotateResponse,
  type EstateAbandonRequest,
  type EstateAbandonResponse,
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
  type RunAgentResponse,
  type RunPaneResponse,
  type RunRequest,
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
import { journalEventSeqFromReceipt } from './journal-receipt.ts';
import { createHash } from 'node:crypto';
import type { EventStore } from './store.ts';
import { findTmuxId } from './ids.ts';
import { buildProjections, type Projections, type LaunchComposition, type TransportClaim } from './projections.ts';
import {
  isStackPage,
  isStackSeat,
  isTxdPage,
  TXD_ESTATE,
  TXD_WINDOWS,
  type TxdPage,
  type TxdStackPage,
} from './estate.ts';
import type { SshSeatTargets } from './config.ts';
import { ENVELOPE_PREFIX, envelopeSessionName, type RemoteEnvelopeLister } from './envelopes.ts';
import { NOOP_ROTATION_BARRIER, type EstateRotationBarrier } from './rotation-lock.ts';
import type { TmuxControlPlane } from './tmux.ts';
import type { TxdPublishedEventType } from './events.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const DOOR1_REQUIRED_ATTESTATIONS = ['identity', 'persona', 'tint'] as const;

type Now = () => string;
// What txd hands lifecycled to arm one comm watch: enough to name the
// subscription's agent stream and the message a composer-quiet fact may redrive.
export type CommWatchArmInput = {
  message_id: string;
  target_agent_id: string;
  source_agent_id: string;
  composer_interactive_observed: boolean;
};
export type ComposerGateInput = { correlation_id: string; target_agent_id: string };
export type CommReceiptRuntime = {
  now: () => number;
  schedule: (wake: () => void, delayMs: number) => () => void;
};
const DEFAULT_COMM_RECEIPT_RUNTIME: CommReceiptRuntime = {
  now: () => Date.now(),
  schedule: (wake, delayMs) => {
    const timer = setTimeout(wake, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

// The ONE comm frame template. comm() stages it and commRedrive() verifies
// the composer against it; a second copy of this string would let the two
// silently diverge and turn every redrive into a false `composer_corrupted`.
function commFrame(messageId: string, sourceAgentId: string, askId: string | null, message: string): string {
  return `[tx comm ${messageId} from ${sourceAgentId}${askId ? ` ask ${askId}` : ''}]\n${message}`;
}

function renderCommIntent(intent: CommIntent, engine: 'claude' | 'codex'): { frame: string; tabAfter: string } {
  const prefix = intent.kind === 'command' || engine === 'claude' ? '/' : '$';
  const tabAfter = `${prefix}${intent.name}`;
  return { tabAfter, frame: intent.args.length > 0 ? `${tabAfter} ${intent.args.join(' ')}` : tabAfter };
}

export type PhysicalRegistrationRuntime = {
  machine: string;
  configuration: { generation: string; digest: string };
  agentWrapper: string;
  perpetual: Record<string, 'claude' | 'codex'>;
  sshSeatTargets: SshSeatTargets;
  publish: (
    eventType: TxdPublishedEventType,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
};

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
  private deliveryWaiters = new Map<string, Set<() => void>>();
  private composerObservationsInFlight = new Map<string, Promise<boolean>>();
  // Live pane-shell runs by seat, so a physical pane replacement can abort
  // exactly the completions whose signal died with the pane's shell.
  private paneRuns = new Map<string, Set<AbortController>>();


  constructor(
    private store: EventStore,
    private tmux: TmuxControlPlane,
    private now: Now = () => new Date().toISOString(),
    private rotationBarrier: EstateRotationBarrier = NOOP_ROTATION_BARRIER,
    private physicalRegistration: PhysicalRegistrationRuntime | null = null,
    private remoteEnvelopes: RemoteEnvelopeLister | null = null,
    /** Arms lifecycled's comm watch pre-send; null = no watch plane configured. */
    private commWatchArm: ((input: CommWatchArmInput) => Promise<void>) | null = null,
    private composerGate: ((input: ComposerGateInput) => Promise<void>) | null = null,
    private commReceiptRuntime: CommReceiptRuntime = DEFAULT_COMM_RECEIPT_RUNTIME,
  ) {}

  private sshSeatTarget(seatId: string): string | undefined {
    return this.physicalRegistration?.sshSeatTargets.targetFor(seatId);
  }

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
        kind: this.sshSeatTarget(observed.pane_id) ? 'ssh' : 'local',
        agent_id: composition?.agent_id ?? null,
        wrapper_pid: hook.wrapper_pid,
        configuration: this.physicalRegistration.configuration,
        worktree: composition?.worktree ?? null,
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
  dispatch(request: DispatchRequested, receipt: string | null = null): Promise<void> {
    return this.locked(async () => {
      if (!this.physicalRegistration) throw new Error('physical_registration_unconfigured');
      const publish = this.physicalRegistration.publish;
      const machine = this.physicalRegistration.machine;
      const priorEvents = await this.store.readByEntity(request.agent_id);
      const priorRequest = priorEvents.find((event) =>
        event.event_type === 'reg.dispatch_requested'
        && event.payload.dispatch_id === request.dispatch_id
        && event.payload.request !== undefined);
      if (priorRequest && JSON.stringify(priorRequest.payload.request) !== JSON.stringify(request)) {
        throw new Error('dispatch_request_conflict');
      }
      const priorTerminal = priorEvents.findLast((event) =>
        event.event_type === 'reg.dispatch_requested'
        && event.payload.dispatch_id === request.dispatch_id
        && typeof event.payload.outcome_event_type === 'string'
        && event.payload.outcome !== undefined);
      if (priorTerminal) {
        await publish(
          priorTerminal.payload.outcome_event_type as TxdPublishedEventType,
          priorTerminal.payload.outcome as Record<string, unknown>,
        );
        return;
      }
      if (!priorRequest) {
        await this.store.append({
          entity_type: 'agent',
          entity_id: request.agent_id,
          event_type: 'reg.dispatch_requested',
          payload: { dispatch_id: request.dispatch_id, request },
          provenance: this.prov('observer', receipt),
          occurred_at: this.now(),
        });
      }
      const terminalize = async (
        eventType: 'agent.dispatch_attested' | 'agent.dispatch_refused',
        outcome: Record<string, unknown>,
      ): Promise<void> => {
        await this.store.append({
          entity_type: 'agent',
          entity_id: request.agent_id,
          event_type: 'reg.dispatch_requested',
          payload: { dispatch_id: request.dispatch_id, outcome_event_type: eventType, outcome },
          provenance: this.prov('observer', receipt),
          occurred_at: this.now(),
        });
        await publish(eventType, outcome);
      };
      const refuse = async (reason: DispatchRefused['reason'], seats: DispatchRefused['seats'] = []) => terminalize(
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
      // A successful engine start owns the seat immediately. Registration is
      // asynchronous, so waiting for reg.bound would put the same seat back on
      // the freelist during the wrapper's startup window and let a later birth
      // silently replace it. Dispatch itself runs under txd's single-writer
      // mutex; this durable composition is the occupancy fact the next
      // acquisition observes after that mutex changes hands.
      const launching = new Set(projections.launchCompositions.keys());
      const paneBySeat = new Map(projections.seatBoard.map((row) => [row.seat_id, row.pane]));
      const workloads = new Map((await this.tmux.workloads()).map((row) => [row.seat_id, row]));
      // One candidate's seat-level truth, first disqualifier in a fixed order.
      const disqualify = (candidate: string): Exclude<SeatDisqualifier, 'foreign_process'> | null => {
        if (projections.decommissionedSeats.has(candidate)) return 'decommissioned';
        if (pendingResetSeats.has(candidate)) return 'reset_pending';
        if (bound.has(candidate)) return 'bound';
        if (launching.has(candidate)) return 'launching';
        const pane = paneBySeat.get(candidate);
        if (pane !== 'live' && pane !== 'empty') return 'dead';
        return null;
      };
      const idle = (candidate: string) => workloads.get(candidate)?.idle ?? false;
      let seatId: string;
      let mintedStackSeat: string | null = null;
      const decommissionMintedStackSeat = async (): Promise<void> => {
        if (!mintedStackSeat) return;
        const seat = mintedStackSeat;
        await this.tmux.killSeat(seat);
        if ((await this.tmux.listSeats()).some((row) => row.seat_id === seat && row.pane === 'live')) {
          throw new Error(`txd could not verify minted stack seat cleanup for ${seat}`);
        }
        await this.store.append({
          entity_type: 'seat',
          entity_id: seat,
          event_type: 'reg.seat_decommissioned',
          payload: {},
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
        mintedStackSeat = null;
      };
      const mintStackSeat = async (page: TxdStackPage): Promise<string | null> => {
        const candidate = `${page}:${crypto.randomUUID()}`;
        try {
          await this.tmux.createStackSeat(page, candidate);
        } catch {
          return null;
        }
        mintedStackSeat = candidate;
        try {
          await this.store.append({
            entity_type: 'seat',
            entity_id: candidate,
            event_type: 'reg.pane_created',
            payload: { pane_state: 'live' },
            provenance: this.prov('observer', null),
            occurred_at: this.now(),
          });
        } catch (error) {
          await decommissionMintedStackSeat();
          throw error;
        }
        return candidate;
      };
      const configuredStackPage = (target: DispatchRequested['target']): TxdStackPage | null =>
        target.stack_page && isStackPage(target.stack_page) ? target.stack_page : null;
      const pageStates = (page: TxdPage) => (TXD_WINDOWS[page] as readonly string[]).map((candidate) => ({
        seat_id: candidate,
        state: disqualify(candidate) ?? (idle(candidate) ? null : 'foreign_process' as const),
      }));
      if (request.target.kind === 'page') {
        const page = request.target.page;
        if (!isTxdPage(page)) {
          await refuse('page_absent');
          return;
        }
        if (isStackPage(page)) {
          const minted = await mintStackSeat(page);
          if (!minted) {
            await refuse('seat_start_failed');
            return;
          }
          seatId = minted;
        } else {
          // Declared page order, so which seat an autofill takes is
          // reproducible. Autofill never displaces a foreign foreground
          // process: when txd itself is choosing, only an idle shell is free.
          const states = pageStates(page);
          const chosen = states.find((candidate) => candidate.state === null);
          if (!chosen) {
            const stackPage = configuredStackPage(request.target);
            const minted = stackPage ? await mintStackSeat(stackPage) : null;
            if (!minted) {
              await refuse('no_free_seat', states.map((candidate) => ({
                seat_id: candidate.seat_id,
                state: candidate.state!,
              })));
              return;
            }
            seatId = minted;
          } else {
            seatId = chosen.seat_id;
          }
        }
      } else {
        // An explicitly named seat replaces whatever its pane is running —
        // naming the seat is the authorization, and the CLI's in-place
        // default resolves to the invoking pane, whose foreground is the
        // invoker itself. Only a live agent binding or estate-level state
        // refuses.
        seatId = request.target.seat_id;
        if (!TXD_ESTATE.includes(seatId) || isStackSeat(seatId)) {
          await refuse('seat_absent');
          return;
        }
        const state = disqualify(seatId);
        if (state !== null) {
          const page = seatId.split(':', 1)[0]!;
          const stackPage = configuredStackPage(request.target);
          const noFreeDeclaredSeat = isTxdPage(page) && !isStackPage(page)
            && pageStates(page).every((candidate) => candidate.state !== null);
          const minted = stackPage && noFreeDeclaredSeat ? await mintStackSeat(stackPage) : null;
          if (minted) {
            seatId = minted;
          } else {
            const reason = ({
              bound: 'seat_bound',
              launching: 'seat_launching',
              decommissioned: 'seat_decommissioned',
              reset_pending: 'seat_reset_pending',
              dead: 'pane_dead',
            } as const)[state];
            await refuse(reason, [{ seat_id: seatId, state }]);
            return;
          }
        }
      }
      let launchComposed = false;
      try {
        const paneGeneration = await this.tmux.seatGeneration(seatId);
        if (!paneGeneration) {
          await decommissionMintedStackSeat();
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
        const sshTarget = this.sshSeatTarget(seatId);
        if (!(await this.tmux.startSeatEngine({
          seatId,
          engine: request.engine,
          wrapper: this.physicalRegistration.agentWrapper,
          agentId: request.agent_id,
          launchNonce,
          ...(sshTarget ? { sshTarget } : {}),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        }))) {
          await decommissionMintedStackSeat();
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
            worktree: request.worktree ?? null,
          },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
        launchComposed = true;
        await terminalize('agent.dispatch_attested', DispatchAttestedSchema.parse({
          schema_version: request.schema_version,
          dispatch_id: request.dispatch_id,
          machine,
          seat_id: seatId,
          pane_generation: paneGeneration,
          engine: request.engine,
        }));
      } catch (error) {
        if (launchComposed && !mintedStackSeat) {
          const terminalPersisted = (await this.store.readByEntity(request.agent_id)).some((event) =>
            event.event_type === 'reg.dispatch_requested'
            && event.payload.dispatch_id === request.dispatch_id
            && typeof event.payload.outcome_event_type === 'string'
            && event.payload.outcome !== undefined);
          if (!terminalPersisted) {
            if (!(await this.tmux.resetSeat(seatId))) {
              throw new AggregateError([error], `txd could not reset failed launch at ${seatId}`);
            }
            await this.store.append({
              entity_type: 'seat',
              entity_id: seatId,
              event_type: 'reg.seat_cleared',
              payload: {},
              provenance: this.prov('observer', null),
              occurred_at: this.now(),
            });
          }
        }
        await decommissionMintedStackSeat();
        throw error;
      }
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
      const seatTarget = this.sshSeatTarget(observed.pane_id);
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
          || agent.placement.machine !== (this.sshSeatTarget(binding.seat_id) ?? this.physicalRegistration.machine)
          || agent.placement.kind !== (this.sshSeatTarget(binding.seat_id) ? 'ssh' : 'local')
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
      if (!this.sshSeatTarget(binding.seat_id) || !binding.pane_generation) continue;
      const composition = liveComposition(
        projections.launchCompositions.get(binding.seat_id),
        binding.pane_generation,
      );
      if (composition) expected.add(envelopeSessionName(binding.seat_id, composition.launch_nonce));
    }
    const zombies: Array<{ target: string; session_name: string }> = [];
    for (const target of this.physicalRegistration?.sshSeatTargets.targets ?? []) {
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

  // Arm the delivery watch and composer gate BEFORE bytes go to the pane.
  // A dead lifecycle plane is a hard stop: sending without its gate would
  // recreate the newborn-composer race this contract exists to prevent.
  private async armCommWatch(
    messageId: string,
    sourceAgentId: string,
    targetAgentId: string,
    transportReceipt: string | null,
  ): Promise<void> {
    if (!this.commWatchArm) return;
    try {
      const composerInteractiveObserved = await this.backfillComposerInteractivity(targetAgentId, transportReceipt);
      await this.commWatchArm({
        message_id: messageId,
        target_agent_id: targetAgentId,
        source_agent_id: sourceAgentId,
        composer_interactive_observed: composerInteractiveObserved,
      });
    } catch (error) {
      await this.locked(() => this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'act.comm_watch_unarmed',
        payload: { message_id: messageId, target_agent_id: targetAgentId, detail: String(error) },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now() }));
      throw error;
    }
  }

  private async backfillComposerInteractivity(
    targetAgentId: string,
    transportReceipt: string | null,
  ): Promise<boolean> {
    if (!this.physicalRegistration) return false;
    const observation = await this.locked(async () => {
      const events = await this.store.readAll();
      const binding = buildProjections(events).currentBindings.find((row) =>
        row.registered && row.agent_id === targetAgentId,
      );
      if (!binding?.pane_generation) return null;
      const observationId = `${targetAgentId}:${binding.pane_generation}`;
      return {
        observationId,
        seatId: binding.seat_id,
        paneGeneration: binding.pane_generation,
        announced: events.some((event) => event.entity_id === observationId
          && event.event_type === 'act.composer_interactive_announced'),
      };
    });
    if (!observation || !await this.tmux.observeComposerInteractive(observation.seatId)) return false;
    if (observation.announced) return true;
    const inFlight = this.composerObservationsInFlight.get(observation.observationId);
    if (inFlight) return inFlight;
    const announcement = (async () => {
      const occurredAt = this.now();
      const shouldPublish = await this.locked(async () => {
        const events = await this.store.readAll();
        const current = buildProjections(events).currentBindings.find((row) =>
          row.registered
          && row.agent_id === targetAgentId
          && row.seat_id === observation.seatId
          && row.pane_generation === observation.paneGeneration,
        );
        if (!current) return false;
        if (events.some((event) => event.entity_id === observation.observationId
          && event.event_type === 'act.composer_interactive_announced')) return false;
        if (!events.some((event) => event.entity_id === observation.observationId
          && event.event_type === 'reg.composer_observation_prepared')) {
          await this.store.append({
            entity_type: 'agent',
            entity_id: observation.observationId,
            event_type: 'reg.composer_observation_prepared',
            payload: {
              agent_id: targetAgentId,
              seat_id: observation.seatId,
              pane_generation: observation.paneGeneration,
            },
            provenance: this.prov('observer', transportReceipt),
            occurred_at: occurredAt,
          });
        }
        return true;
      });
      if (!shouldPublish) return true;
      await this.physicalRegistration!.publish('agent.composer_interactive', {
        schema_version: SCHEMA_VERSION,
        agent_id: targetAgentId,
        seat_id: observation.seatId,
        pane_generation: observation.paneGeneration,
        observed_at: occurredAt,
      });
      await this.locked(async () => {
        const events = await this.store.readAll();
        if (events.some((event) => event.entity_id === observation.observationId
          && event.event_type === 'act.composer_interactive_announced')) return;
        await this.store.append({
          entity_type: 'agent',
          entity_id: observation.observationId,
          event_type: 'act.composer_interactive_announced',
          payload: {
            agent_id: targetAgentId,
            seat_id: observation.seatId,
            pane_generation: observation.paneGeneration,
          },
          provenance: this.prov('observer', transportReceipt),
          occurred_at: this.now(),
        });
      });
      return true;
    })();
    this.composerObservationsInFlight.set(observation.observationId, announcement);
    try {
      return await announcement;
    } finally {
      if (this.composerObservationsInFlight.get(observation.observationId) === announcement) {
        this.composerObservationsInFlight.delete(observation.observationId);
      }
    }
  }

  async comm(req: CommRequest, transportReceipt: string | null = null): Promise<CommAccepted> {
    const prepared = await this.locked(async () => {
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
      const intentBinding = req.intent
        ? proj.currentBindings.find((binding) => binding.registered && binding.agent_id === targets[0]?.agent_id)
        : null;
      if (req.intent && !intentBinding?.engine) throw new Error(`target_engine_unresolved: ${targets[0]?.agent_id}`);
      const renderedIntent = req.intent ? renderCommIntent(req.intent, intentBinding!.engine!) : null;
      const messageId = crypto.randomUUID();
      const askId = req.ask ? crypto.randomUUID() : null;
      const occurred_at = this.now();
      const accepted = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted', payload: {
        source_agent_id: req.source_agent_id, target_agent_ids: targets.map((t) => t.agent_id), targets,
        ask_id: askId, reply_to_ask_id: replyingToAsk,
        kind: req.intent?.kind ?? 'message',
        name: req.intent?.name ?? null,
        rendered_frame: renderedIntent?.frame ?? null,
        message: req.message ?? renderedIntent!.frame,
        ...(req.intent ? { intent: req.intent } : {}),
      }, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      const snapshot = await this.store.append({ entity_type: askId ? 'ask' : 'message', entity_id: askId ?? messageId,
        event_type: 'reg.comm_target_snapshotted', payload: { message_id: messageId, targets }, provenance: this.prov('observer', transportReceipt), occurred_at });
      return { messageId, askId, replyingToAsk, targets, renderedIntent, eventIds: [accepted.seq, snapshot.seq] };
    });

    await Promise.all(prepared.targets.map((target) => {
      return this.armCommWatch(prepared.messageId, req.source_agent_id, target.agent_id, transportReceipt);
    }));

    const plans = await this.locked(async () => {
      const proj = await this.projections();
      const events = await this.store.readAll();
      const pendingResetSeats = this.pendingScopedResetSeats(events);
      for (const target of prepared.targets) {
        const binding = proj.currentBindings.find((row) => row.registered
          && row.agent_id === target.agent_id && row.seat_id === target.seat_id);
        if (!binding) throw new Error(`target_binding_changed: ${target.agent_id}`);
        if (pendingResetSeats.has(target.seat_id)) throw new Error(`scoped_reset_pending: ${target.seat_id}`);
      }
      return prepared.targets.map((target) => {
        const binding = proj.currentBindings.find((row) => row.registered
          && row.agent_id === target.agent_id && row.seat_id === target.seat_id)!;
        const frame = prepared.renderedIntent?.frame
          ?? commFrame(prepared.messageId, req.source_agent_id, prepared.askId, req.message!);
        return { target, binding, frame };
      });
    });

    // Tmux repaint is an external wait. It must never hold the journal mutex:
    // UserPromptSubmit can arrive as soon as Enter is driven, and that hook is
    // the effect fact this transaction exists to record. Event 37076 proved
    // the old inversion: staging held this.locked for five minutes, edge-proxy
    // reached txd with the hook, and timed out before txd could admit it.
    const outcomes: Array<{ plan: typeof plans[number]; sent: Awaited<ReturnType<TmuxControlPlane['sendVerifiedToSeat']>> }> = [];
    for (const plan of plans) {
      const sent = await this.tmux.sendVerifiedToSeat(
        plan.target.seat_id,
        prepared.messageId,
        plan.frame,
        prepared.renderedIntent?.tabAfter,
        plan.binding.engine ?? undefined,
      );
      outcomes.push({ plan, sent });
    }

    const accepted: CommAccepted = await this.locked(async () => {
      const event_ids = [...prepared.eventIds];
      let allStaged = true;
      for (const { plan, sent } of outcomes) {
        const event = await this.store.append({ entity_type: 'message', entity_id: prepared.messageId, event_type: 'act.comm_bytes_sent',
          payload: {
            target_agent_id: plan.target.agent_id, seat_id: plan.target.seat_id, bytes: sent.bytes,
            submit_verdict: sent.verdict, kind: req.intent?.kind ?? 'message',
            name: req.intent?.name ?? null, rendered_frame: plan.frame,
            receipt_deadline_at: new Date(this.commReceiptRuntime.now() + COMM_DELIVERY_RECEIPT_TIMEOUT_MS).toISOString(),
          }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
        event_ids.push(event.seq);
        allStaged &&= sent.verdict === 'staged';
      }
      if (prepared.replyingToAsk) await this.assertCallback(prepared.replyingToAsk, req.source_agent_id, req.message!, 'reply', null, transportReceipt);
      return { ok: true, message_id: prepared.messageId, ask_id: prepared.askId, source_agent_id: req.source_agent_id,
        targets: prepared.targets, staged: allStaged, event_ids };
    });
    // A non-zero refusal means pane mutation happened even though Enter could
    // not be attested. Re-drive immediately from the durable accepted frame;
    // this is downstream recovery and never retypes or guesses at the draft.
    for (const { plan, sent } of outcomes) {
      if (sent.verdict === 'staged' || sent.bytes === 0) continue;
      const outcome = await this.tmux.redriveSeatComm(plan.target.seat_id, prepared.messageId, plan.frame);
      const event = await this.locked(() => this.store.append({
        entity_type: 'message', entity_id: prepared.messageId, event_type: 'act.comm_redrive_attempted',
        payload: {
          message_id: prepared.messageId,
          target_agent_id: plan.target.agent_id,
          seat_id: plan.target.seat_id,
          trigger: 'retained_after_send',
          outcome,
        },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
      }));
      accepted.event_ids.push(event.seq);
    }
    return accepted;
  }

  async inject(req: { schema_version: number; target_agent_id: string; text: string }, transportReceipt: string | null = null) {
    const prepared = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      const binding = proj.currentBindings.find((row) => row.registered && row.agent_id === req.target_agent_id);
      if (!binding) throw new Error(`target_unbound: ${req.target_agent_id}`);
      const correlationId = crypto.randomUUID();
      return { binding, correlationId };
    });
    if (!this.composerGate) throw new Error('composer_gate_unconfigured');
    await this.composerGate({ correlation_id: prepared.correlationId, target_agent_id: req.target_agent_id });

    return this.locked(async () => {
      const proj = await this.projections();
      const binding = proj.currentBindings.find((row) => row.registered
        && row.agent_id === req.target_agent_id && row.seat_id === prepared.binding.seat_id);
      if (!binding) throw new Error(`target_binding_changed: ${req.target_agent_id}`);
      const sent = await this.tmux.sendVerifiedToSeat(binding.seat_id, prepared.correlationId, req.text, undefined, binding.engine ?? undefined);
      await this.store.append({ entity_type: 'message', entity_id: prepared.correlationId, event_type: 'act.agent_input_injected',
        payload: { target_agent_id: req.target_agent_id, seat_id: binding.seat_id, bytes: sent.bytes, submit_verdict: sent.verdict, input_class: 'machine_feed' },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
      // The HTTP success is lifecycled's acknowledgement boundary. Anything
      // short of a verified Enter must fail the request so its durable bus
      // subscription retains the event for event-driven redelivery.
      if (sent.verdict !== 'staged') throw new Error(`machine_feed_not_staged: ${sent.verdict}`);
      return { ok: true as const, target_agent_id: req.target_agent_id, deferred: true as const };
    });
  }

  /**
   * `tx run` — one shell command against one pane, branching on txd's own
   * event truth (never a process heuristic). A target resolving to a
   * REGISTERED binding is an agent pane: the command is staged through the
   * engine's `!` shell escape so its output lands in that agent's
   * conversation. A bare declared seat executes the command in its idle pane
   * shell; completion is the pane's own wait-for signal (the command exited)
   * and the harvest returns to the caller as a deferred body.
   */
  async run(req: RunRequest, transportReceipt: string | null = null): Promise<
    | { mode: 'agent'; response: RunAgentResponse }
    | { mode: 'pane'; pending: Promise<RunPaneResponse> }
  > {
    const prepared = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      const events = await this.store.readAll();
      const pendingResetSeats = this.pendingScopedResetSeats(events);
      const matches = proj.currentBindings.filter((binding) =>
        binding.registered && (
          binding.agent_id === req.target
          || binding.persona === req.target
          || binding.seat_id === req.target
        ),
      );
      if (matches.length > 1) throw new Error(AMBIGUOUS_IDENTITY(req.target));
      if (matches.length === 1) {
        const binding = matches[0]!;
        if (pendingResetSeats.has(binding.seat_id)) throw new Error(`scoped_reset_pending: ${binding.seat_id}`);
        if (!binding.agent_id || !binding.engine) throw new Error(`engine_unattested: ${req.target}`);
        return { kind: 'agent' as const, binding };
      }
      // No registered binding answers to this identity, so the only reading
      // left is a bare declared seat. Anything else is absent — loud.
      if (!TXD_ESTATE.includes(req.target)) throw new Error(`identity_absent: ${req.target}`);
      if (proj.decommissionedSeats.has(req.target)) throw new Error(`seat_decommissioned: ${req.target}`);
      // A binding mid-birth is an agent arriving; racing its registration
      // with a shell line would type into its wrapper.
      if (proj.currentBindings.some((binding) => binding.seat_id === req.target)) {
        throw new Error(`seat_binding_pending: ${req.target}`);
      }
      if (pendingResetSeats.has(req.target)) throw new Error(`scoped_reset_pending: ${req.target}`);
      const row = proj.seatBoard.find((entry) => entry.seat_id === req.target);
      if (row && row.pane === 'dead') throw new Error(`pane_dead: ${req.target}`);
      return { kind: 'pane' as const, seatId: req.target };
    });

    const runId = crypto.randomUUID();
    if (prepared.kind === 'agent') {
      const response = await this.locked(async (): Promise<RunAgentResponse> => {
        const proj = await this.projections();
        const binding = proj.currentBindings.find((row) => row.registered
          && row.agent_id === prepared.binding.agent_id && row.seat_id === prepared.binding.seat_id);
        if (!binding) throw new Error(`target_binding_changed: ${req.target}`);
        const sent = await this.tmux.runInAgentComposer(binding.seat_id, runId, req.command, binding.engine!);
        // Payload holds dumb correlation facts only. The command LINE never
        // enters the append-only stream: like inject's text, it can carry
        // credentials, and an event cannot be redacted later — the digest
        // correlates without persisting the bytes.
        const event = await this.store.append({ entity_type: 'message', entity_id: runId, event_type: 'act.agent_input_injected',
          payload: {
            target_agent_id: binding.agent_id, seat_id: binding.seat_id, bytes: sent.bytes,
            submit_verdict: sent.verdict, input_class: 'harness_shell', command_digest: sha256(req.command),
          },
          provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
        if (sent.verdict !== 'staged') throw new Error(`run_not_staged: ${sent.verdict}`);
        return {
          ok: true, mode: 'agent', run_id: runId, target: req.target, seat_id: binding.seat_id,
          agent_id: binding.agent_id!, engine: binding.engine!, staged: true, event_ids: [event.seq],
        };
      });
      return { mode: 'agent', response };
    }

    const controller = new AbortController();
    const registered = this.paneRuns.get(prepared.seatId) ?? new Set<AbortController>();
    registered.add(controller);
    this.paneRuns.set(prepared.seatId, registered);
    let staged: Awaited<ReturnType<TmuxControlPlane['runInShellPane']>>;
    try {
      // Staging under the writer lock: a concurrent reset cannot replace the
      // pane process between the idle observation and the typed line.
      staged = await this.locked(() => this.tmux.runInShellPane(prepared.seatId, runId, req.command, controller.signal));
    } catch (error) {
      registered.delete(controller);
      throw error;
    }
    const pending = staged.completion
      .then((outcome): RunPaneResponse => ({ ok: true, mode: 'pane', run_id: runId, seat_id: prepared.seatId, ...outcome }))
      .finally(() => { registered.delete(controller); });
    return { mode: 'pane', pending };
  }

  /** A physical pane replacement is the death event of every run staged in it. */
  private abortPaneRuns(seatId: string): void {
    for (const controller of this.paneRuns.get(seatId) ?? []) controller.abort();
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

  private wakeDelivery(messageId: string): void {
    for (const wake of this.deliveryWaiters.get(messageId) ?? []) wake();
    this.deliveryWaiters.delete(messageId);
  }

  // One flush, every message it carried. A frame this agent was never a target
  // of belongs to someone else's correspondence and is skipped in silence; only
  // a flush that matched NOTHING is a refusal, so an ordinary prompt still
  // fails deterministically instead of wedging the lane.
  promptSubmitted(hook: CommHook, receipt: string | null = null): Promise<{ ok: true; asserted: string[]; dead_lettered: string[] }> {
    return this.locked(async () => {
      const events = await this.store.readAll();
      const asserted: string[] = [];
      const matchedMessageIds: string[] = [];
      const confirmations = new Map<string, string[]>();
      let matched = false;
      const intentMessage = hook.content === undefined ? undefined : events.find((event) =>
        event.event_type === 'reg.comm_accepted'
        && (event.payload.kind === 'command' || event.payload.kind === 'skill')
        && event.payload.rendered_frame === hook.content
        && Array.isArray(event.payload.target_agent_ids)
        && event.payload.target_agent_ids.includes(hook.agent_id)
        && !events.some((candidate) => candidate.event_type === 'act.comm_delivery_asserted'
          && candidate.payload.message_id === event.entity_id
          && candidate.payload.target_agent_id === hook.agent_id));
      const messageIds = [...new Set([...hook.message_ids, ...(intentMessage ? [intentMessage.entity_id] : [])])];
      for (const messageId of messageIds) {
        const accepted = events.find((e) => e.entity_id === messageId && e.event_type === 'reg.comm_accepted');
        if (!accepted || !(accepted.payload.target_agent_ids as unknown[]).includes(hook.agent_id)) continue;
        matched = true;
        matchedMessageIds.push(messageId);
        const assertionId = `${messageId}:${hook.agent_id}`;
        if (!events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_delivery_asserted')) {
          await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
            payload: { message_id: messageId, target_agent_id: hook.agent_id, source_agent_id: accepted.payload.source_agent_id }, provenance: this.prov('hook', receipt), occurred_at: this.now() });
          asserted.push(messageId);
        }
        this.wakeDelivery(messageId);
        const sourceAgentId = String(accepted.payload.source_agent_id);
        const confirmationStaged = events.some((event) => event.event_type === 'act.agent_input_injected'
          && event.payload.input_class === 'delivery_confirmation'
          && event.payload.submit_verdict === 'staged'
          && event.payload.target_agent_id === sourceAgentId
          && Array.isArray(event.payload.message_ids)
          && event.payload.message_ids.includes(messageId));
        const bytesSent = events.find((event) => event.event_type === 'act.comm_bytes_sent'
          && event.entity_id === messageId
          && event.payload.target_agent_id === hook.agent_id);
        const deadline = Date.parse(String(bytesSent?.payload.receipt_deadline_at ?? ''));
        // A hook may win the race against the post-stage bytes receipt now
        // that composer I/O no longer owns the journal mutex. That is the
        // fastest tier-1 success, not evidence that the 30-second bound passed.
        const asynchronous = bytesSent !== undefined
          && Number.isFinite(deadline)
          && this.commReceiptRuntime.now() >= deadline;
        if (!confirmationStaged && asynchronous) {
          confirmations.set(sourceAgentId, [...(confirmations.get(sourceAgentId) ?? []), messageId]);
        }
      }
      if (!matched) throw new Error('message_target_mismatch');
      const proj = await this.projections();
      const liveDeliveryTarget = proj.currentBindings.some((binding) =>
        binding.registered && binding.agent_id === hook.agent_id);
      if (!liveDeliveryTarget) {
        const retired = proj.turnByAgent.get(hook.agent_id) === 'retired';
        const historicBinding = [...events].reverse().find((event) =>
          event.event_type === 'reg.bound' && event.payload.agent_id === hook.agent_id);
        const deadLettered: string[] = [];
        for (const messageId of matchedMessageIds) {
          const deadLetterId = `delivery-confirmation-dead-letter:${messageId}:${hook.agent_id}`;
          if (events.some((event) => event.entity_id === deadLetterId
            && event.event_type === 'act.comm_delivery_confirmation_dead_lettered')) continue;
          const accepted = events.find((event) =>
            event.entity_id === messageId && event.event_type === 'reg.comm_accepted')!;
          await this.store.append({
            entity_type: 'assertion',
            entity_id: deadLetterId,
            event_type: 'act.comm_delivery_confirmation_dead_lettered',
            payload: {
              journal_event_seq: journalEventSeqFromReceipt(receipt),
              message_id: messageId,
              source_agent_id: accepted.payload.source_agent_id,
              delivery_target_agent_id: hook.agent_id,
              delivery_target_session_id: hook.session_id ?? null,
              delivery_target_seat_id: historicBinding?.entity_id ?? null,
              delivery_target_pane_generation: historicBinding?.payload.pane_generation ?? null,
              delivery_target_birth_generation: historicBinding?.payload.birth_generation ?? null,
              reason: retired ? 'delivery_target_retired' : 'delivery_target_unbound',
            },
            provenance: this.prov('hook', receipt),
            occurred_at: this.now(),
          });
          deadLettered.push(messageId);
        }
        return { ok: true, asserted, dead_lettered: deadLettered };
      }
      // One line per sender, not one per message: the confirmation lands in a
      // composer that coalesces exactly like the one it is reporting on, and a
      // burst of them is the same defect pointed back at the sender.
      for (const [sourceAgentId, messageIds] of confirmations) {
        const sender = proj.currentBindings.find((b) => b.agent_id === sourceAgentId);
        if (!sender) continue;
        const correlationId = crypto.randomUUID();
        const renderedFrame = `[tx comm delivery confirmed ${messageIds.join(' ')} target ${hook.agent_id}]`;
        const sent = await this.tmux.sendVerifiedToSeat(sender.seat_id, correlationId, renderedFrame, undefined, sender.engine ?? undefined);
        await this.store.append({ entity_type: 'message', entity_id: correlationId, event_type: 'act.agent_input_injected',
          payload: {
            target_agent_id: sourceAgentId, seat_id: sender.seat_id, bytes: sent.bytes,
            submit_verdict: sent.verdict, input_class: 'delivery_confirmation',
            message_ids: messageIds, rendered_frame: renderedFrame,
          }, provenance: this.prov('observer', receipt), occurred_at: this.now() });
        if (sent.verdict !== 'staged') throw new Error(`delivery_confirmation_not_staged:${sent.verdict}`);
      }
      return { ok: true, asserted, dead_lettered: [] };
    });
  }

  // The remedial half of the two-phase comm contract is a deliberate pane
  // action. Lifecycled's named fact edge decides WHEN; this is mechanism only
  // and remains idempotent against a late organic submit.
  private async commRemedialContext(messageId: string, targetAgentId: string) {
    const events = await this.store.readAll();
    const accepted = events.find((e) => e.entity_id === messageId && e.event_type === 'reg.comm_accepted');
    if (!accepted) throw new Error('message_absent');
    if (!(accepted.payload.target_agent_ids as unknown[]).includes(targetAgentId)) throw new Error('target_mismatch');
    const delivered = events.some((e) => e.entity_id === `${messageId}:${targetAgentId}` && e.event_type === 'act.comm_delivery_asserted');
    return { events, accepted, delivered };
  }

  commRedrive(req: CommRedriveRequest, transportReceipt: string | null = null): Promise<CommRedriveResponse> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const { events, accepted, delivered } = await this.commRemedialContext(req.message_id, req.target_agent_id);
      const base = { ok: true as const, message_id: req.message_id, target_agent_id: req.target_agent_id };
      // The assertion arriving first is the good ending, not an error — and
      // the pane is not touched, because there is nothing left to submit.
      if (delivered) return { ...base, outcome: 'already_delivered' };
      const proj = await this.projections();
      const binding = proj.currentBindings.find((b) => b.registered && b.agent_id === req.target_agent_id);
      if (!binding) throw new Error(`target_unbound: ${req.target_agent_id}`);
      const askId = typeof accepted.payload.ask_id === 'string' ? accepted.payload.ask_id : null;
      const frame = accepted.payload.kind === 'command' || accepted.payload.kind === 'skill'
        ? String(accepted.payload.rendered_frame)
        : commFrame(req.message_id, String(accepted.payload.source_agent_id), askId, String(accepted.payload.message));
      const latestSend = [...events].reverse().find((event) => event.entity_id === req.message_id
        && event.event_type === 'act.comm_bytes_sent'
        && event.payload.target_agent_id === req.target_agent_id);
      let outcome: CommRedriveResponse['outcome'];
      if (latestSend?.payload.submit_verdict === 'composer_draft_present') {
        const intent = accepted.payload.intent as CommIntent | undefined;
        const tabAfter = intent ? renderCommIntent(intent, binding.engine!).tabAfter : undefined;
        const sent = await this.tmux.sendVerifiedToSeat(binding.seat_id, req.message_id, frame, tabAfter, binding.engine!);
        await this.store.append({
          entity_type: 'message', entity_id: req.message_id, event_type: 'act.comm_bytes_sent',
          payload: {
            target_agent_id: req.target_agent_id, seat_id: binding.seat_id, bytes: sent.bytes,
            submit_verdict: sent.verdict, kind: accepted.payload.kind ?? 'message',
            name: accepted.payload.name ?? null, rendered_frame: frame, drain: true,
            receipt_deadline_at: new Date(this.commReceiptRuntime.now() + COMM_DELIVERY_RECEIPT_TIMEOUT_MS).toISOString(),
          },
          provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
        });
        outcome = sent.verdict === 'staged'
          ? 'enter_redriven'
          : sent.verdict === 'composer_draft_present'
            ? 'queued'
            : sent.verdict === 'seat_unresolved' || sent.verdict === 'frame_absent' || sent.verdict === 'submit_unverified'
              ? sent.verdict
              : 'composer_corrupted';
      } else {
        outcome = await this.tmux.redriveSeatComm(binding.seat_id, req.message_id, frame);
      }
      await this.store.append({ entity_type: 'message', entity_id: req.message_id, event_type: 'act.comm_redrive_attempted',
        payload: { message_id: req.message_id, target_agent_id: req.target_agent_id, seat_id: binding.seat_id, outcome },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
      return { ...base, outcome };
    });
  }

  async commRecover(
    req: CommRecoverRequest,
    transportReceipt: string | null = null,
  ): Promise<CommRecoverResponse> {
    const prepared = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const events = await this.store.readAll();
      const proj = buildProjections(events);
      if (!proj.currentBindings.some((binding) => binding.registered && binding.agent_id === req.source_agent_id)) {
        throw new Error('source_not_registered');
      }
      const matches = proj.currentBindings.filter((binding) => binding.registered && (
        binding.agent_id === req.target || binding.persona === req.target || binding.seat_id === req.target
      ));
      if (matches.length === 0) throw new Error(`identity_absent: ${req.target}`);
      if (matches.length > 1) throw new Error(AMBIGUOUS_IDENTITY(req.target));
      const binding = matches[0]!;
      if (!binding.agent_id || !binding.engine) throw new Error(`engine_unattested: ${req.target}`);
      const targetAgentId = binding.agent_id;
      const engine = binding.engine;
      const discarded = new Set(events
        .filter((event) => event.event_type === 'act.comm_draft_discarded'
          && event.payload.target_agent_id === targetAgentId
          && event.payload.outcome === 'discarded')
        .map((event) => event.entity_id));
      const candidate = [...events].reverse().find((event) =>
        event.event_type === 'act.comm_bytes_sent'
        && event.payload.target_agent_id === targetAgentId
        && Number(event.payload.bytes) > 0
        && event.payload.submit_verdict !== 'staged'
        && typeof event.payload.rendered_frame === 'string'
        && !discarded.has(event.entity_id)
        && !events.some((other) => other.event_type === 'act.comm_delivery_asserted'
          && other.payload.message_id === event.entity_id
          && other.payload.target_agent_id === targetAgentId));
      if (!candidate) throw new Error(`retained_comm_absent: ${req.target}`);
      return {
        binding,
        targetAgentId,
        engine,
        messageId: candidate.entity_id,
        frame: String(candidate.payload.rendered_frame),
        bytes: Number(candidate.payload.bytes),
      };
    });

    const outcome = await this.tmux.redriveSeatComm(
      prepared.binding.seat_id,
      prepared.messageId,
      prepared.frame,
    );
    const attempt = await this.locked(() => this.store.append({
      entity_type: 'message', entity_id: prepared.messageId, event_type: 'act.comm_redrive_attempted',
      payload: {
        message_id: prepared.messageId,
        target_agent_id: prepared.targetAgentId,
        seat_id: prepared.binding.seat_id,
        source_agent_id: req.source_agent_id,
        trigger: 'operator_recovery',
        outcome,
      },
      provenance: this.prov('wrapper', transportReceipt), occurred_at: this.now(),
    }));
    if (outcome !== 'composer_corrupted' || !req.discard_corrupted) {
      return {
        ok: outcome === 'enter_redriven',
        message_id: prepared.messageId,
        target_agent_id: prepared.targetAgentId,
        outcome,
        event_ids: [attempt.seq],
      };
    }

    const discardOutcome = await this.tmux.discardSeatComposer(
      prepared.binding.seat_id,
      prepared.engine,
    );
    const discarded = await this.locked(() => this.store.append({
      entity_type: 'message', entity_id: prepared.messageId, event_type: 'act.comm_draft_discarded',
      payload: {
        message_id: prepared.messageId,
        target_agent_id: prepared.targetAgentId,
        seat_id: prepared.binding.seat_id,
        source_agent_id: req.source_agent_id,
        bytes: prepared.bytes,
        rendered_frame: prepared.frame,
        outcome: discardOutcome,
      },
      provenance: this.prov('wrapper', transportReceipt), occurred_at: this.now(),
    }));
    return {
      ok: discardOutcome === 'discarded',
      message_id: prepared.messageId,
      target_agent_id: prepared.targetAgentId,
      outcome: discardOutcome === 'seat_unresolved' ? 'discard_failed' : discardOutcome,
      event_ids: [attempt.seq, discarded.seq],
    };
  }

  // Phase two, read back. The delivery fact for one message and every target it
  // was snapshotted against, derived from `act.comm_delivery_asserted` alone —
  // never from the bytes that were staged, which is the conflation this surface
  // exists to end.
  async commDelivery(messageId: string): Promise<CommDeliveryReadResponse> {
    const events = await this.store.readAll();
    const accepted = events.find((e) => e.entity_id === messageId && e.event_type === 'reg.comm_accepted');
    if (!accepted) throw new Error('message_absent');
    const snapshot = events.find((e) => e.event_type === 'reg.comm_target_snapshotted' && e.payload.message_id === messageId);
    const targets = (snapshot?.payload.targets ?? accepted.payload.targets ?? []) as CommTarget[];
    const deliveries = targets.map((target) => {
      const assertion = events.find((e) => e.event_type === 'act.comm_delivery_asserted'
        && e.payload.message_id === messageId && e.payload.target_agent_id === target.agent_id);
      return {
        target, delivered: assertion !== undefined,
        asserted_at: assertion?.occurred_at ?? null,
        assertion_event_id: assertion?.seq ?? null,
      };
    });
    return {
      schema_version: SCHEMA_VERSION, message_id: messageId,
      source_agent_id: String(accepted.payload.source_agent_id),
      accepted_at: accepted.occurred_at,
      deliveries, complete: deliveries.length > 0 && deliveries.every((d) => d.delivered),
    };
  }

  async waitCommReceipt(req: CommReceiptWaitRequest): Promise<CommReceipt> {
    if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
    const state = async () => {
      const events = await this.store.readAll();
      const accepted = events.find((event) => event.entity_id === req.message_id && event.event_type === 'reg.comm_accepted');
      if (!accepted) throw new Error('message_absent');
      if (accepted.payload.source_agent_id !== req.source_agent_id) throw new Error('comm_source_mismatch');
      const delivery = await this.commDelivery(req.message_id);
      const sentRows = events.filter((event) => event.entity_id === req.message_id && event.event_type === 'act.comm_bytes_sent');
      const sent = [...new Map(sentRows.map((event) => [String(event.payload.target_agent_id), event])).values()];
      const deadline = Math.max(...sent.map((event) => Date.parse(String(event.payload.receipt_deadline_at ?? ''))));
      if (!Number.isFinite(deadline)) throw new Error('comm_receipt_deadline_absent');
      const deadlineByTarget = new Map(sent.map((event) => [
        String(event.payload.target_agent_id),
        Date.parse(String(event.payload.receipt_deadline_at ?? '')),
      ]));
      const timely = delivery.complete && delivery.deliveries.every((row) => {
        const targetDeadline = deadlineByTarget.get(row.target.agent_id);
        const assertedAt = Date.parse(row.asserted_at ?? '');
        return targetDeadline !== undefined && Number.isFinite(assertedAt) && assertedAt < targetDeadline;
      });
      const redrivenTargets = new Set(events.filter((event) => event.entity_id === req.message_id
        && event.event_type === 'act.comm_redrive_attempted'
        && event.payload.outcome === 'enter_redriven')
        .map((event) => String(event.payload.target_agent_id)));
      return { accepted, delivery, sent, deadline, timely, redrivenTargets };
    };

    let wake!: () => void;
    const event = new Promise<void>((resolve) => { wake = resolve; });
    const waiters = this.deliveryWaiters.get(req.message_id) ?? new Set<() => void>();
    waiters.add(wake);
    this.deliveryWaiters.set(req.message_id, waiters);
    let cancel = () => {};
    try {
      let current = await state();
      const targets = (current.accepted.payload.targets ?? []) as CommTarget[];
      const unstaged = current.sent.filter((row) => row.payload.submit_verdict !== 'staged'
        && !current.redrivenTargets.has(String(row.payload.target_agent_id)));
      if (current.sent.length === targets.length && unstaged.length > 0) {
        if (unstaged.every((row) => row.payload.submit_verdict === 'composer_draft_present')) {
          return {
            ok: true, schema_version: SCHEMA_VERSION, phase: 'queued',
            message_id: req.message_id, source_agent_id: req.source_agent_id,
            targets, bytes_sent: 0, event_ids: current.sent.map((row) => row.seq),
          };
        }
        const verdicts = new Set(unstaged.map((row) => String(row.payload.submit_verdict)));
        return {
          ok: false, schema_version: SCHEMA_VERSION, phase: 'transport_refused',
          message_id: req.message_id, source_agent_id: req.source_agent_id,
          targets,
          bytes_sent: current.sent.reduce((sum, row) => sum + Number(row.payload.bytes ?? 0), 0),
          submit_verdict: verdicts.size === 1
            ? [...verdicts][0] as 'composer_draft_present' | 'composer_unreadable' | 'composer_corrupted' | 'frame_absent' | 'submit_unverified' | 'seat_unresolved'
            : 'multiple',
          refusals: unstaged.map((row) => ({
            target: targets.find((target) => target.agent_id === row.payload.target_agent_id)!,
            bytes: Number(row.payload.bytes ?? 0),
            submit_verdict: String(row.payload.submit_verdict) as 'composer_draft_present' | 'composer_unreadable' | 'composer_corrupted' | 'frame_absent' | 'submit_unverified' | 'seat_unresolved',
            event_id: row.seq,
          })),
          event_ids: current.sent.map((row) => row.seq),
        };
      }
      if (!current.delivery.complete) {
        await Promise.race([
          event,
          new Promise<void>((resolve) => {
            cancel = this.commReceiptRuntime.schedule(resolve, Math.max(0, current.deadline - this.commReceiptRuntime.now()));
          }),
        ]);
        current = await state();
      }
      if (current.timely) {
        return {
          ok: true, schema_version: SCHEMA_VERSION, phase: 'delivery_confirmed',
          message_id: req.message_id, source_agent_id: req.source_agent_id,
          deliveries: current.delivery.deliveries,
        };
      }
      return {
        ok: true, schema_version: SCHEMA_VERSION, phase: 'bytes_sent',
        message_id: req.message_id, source_agent_id: req.source_agent_id,
        targets,
        bytes_sent: current.sent.reduce((sum, row) => sum + Number(row.payload.bytes ?? 0), 0),
        staged: current.sent.length === targets.length && current.sent.every((row) =>
          row.payload.submit_verdict === 'staged'
          || current.redrivenTargets.has(String(row.payload.target_agent_id))),
        event_ids: current.sent.map((row) => row.seq),
      };
    } finally {
      cancel();
      const current = this.deliveryWaiters.get(req.message_id);
      current?.delete(wake);
      if (current?.size === 0) this.deliveryWaiters.delete(req.message_id);
    }
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
      if (proj.turnByAgent.get(req.identity!) === 'retired') {
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
  // bare `reg.pane_created` (unbound) — it lands in freelist + seat_board and
  // triggers NO contradiction (reconcile only flags bound-dead / retired-live).
  //
  // Buckets: `created` = canonical pane made + event written this run;
  // `backfilled` = canonical pane already there but its event was missing;
  // `existing` = present AND attested. `failed` remains in the response contract
  // but shape failures throw before any event append: half-estates are refused.
  async constructEstate(): Promise<{ created: string[]; existing: string[]; backfilled: string[]; failed: string[] }> {
    const result = await this.locked(async () => {
      await this.recoverBindingPreparations();
      const generation = await this.tmux.estateGeneration();
      if (generation === 'foreign') {
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

      return { created, existing, backfilled, failed };
    });
    await this.announceVacantPerpetualSeats();
    return result;
  }

  /**
   * Boot is allowed to observe an intentionally unrotated predecessor shape,
   * but never to interpret or repair it. The explicit estate rotation remains
   * the only activation boundary; every non-foreign generation takes the
   * ordinary strict constructor path.
   */
  async constructEstateAtBoot(): Promise<{
    created: string[];
    existing: string[];
    backfilled: string[];
    failed: string[];
  } | null> {
    if (await this.tmux.estateGeneration() === 'foreign') return null;
    return this.constructEstate();
  }

  // ── /agents/close — the sanctioned remote-close verb (rung 3) ──────────────
  // Reaps agent processes and returns their estate seats to the freelist. The
  // terminal chain (retired + process_reaped + seat_cleared) is atomic per seat
  // and only written AFTER that process is confirmed reaped — a retire-with-
  // live-process is unspellable (spec §4). Bulk is N independent single-seat
  // closes under one lock acquisition: each target gets its own verdict and its
  // own facts, a refused sibling never blocks a close, and a page is never
  // rebuilt. No silent no-op: an unbound target, a mid-turn agent (absent
  // force), an underranked caller, or a failed reap all
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
      const turnOf = (agentId: string | null): string =>
        (agentId ? proj.turnByAgent.get(agentId) ?? 'unobserved' : 'unobserved');
      // Close is irreversible. An explicit target whose latest durable turn
      // fact is `awaiting_input` names the intended post-stop close boundary;
      // its engine remains alive at the prompt by design. Every other explicit
      // target and every filtered close asks the operating system. There,
      // 'alive' and 'unobservable' both refuse, and only positively observed
      // death admits the close.
      const closable = async (binding: { seat_id: string; agent_id: string | null }) => {
        const liveness = await this.tmux.agentLiveness(binding.seat_id, binding.agent_id ?? '');
        return { liveness, may: liveness === 'dead' };
      };

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
          // Naming one stopped agent is the ordinary lifecycle close, not a
          // force variant. Filters name no agent and never inherit this intent.
          const intendedStoppedClose = turnOf(binding.agent_id) === 'awaiting_input';
          const observed = req.force || intendedStoppedClose ? null : await closable(binding);
          if (observed && !observed.may) {
            // Graceful by default: a live engine is working even when the turn
            // fold says otherwise, and a mid-turn close destroys work and
            // strands attestations.
            verdicts.push({
              target,
              seat_id: binding.seat_id,
              agent_id: binding.agent_id,
              closed: false,
              reason: observed.liveness === 'alive'
                ? `live_engine: an engine for this agent is running under ${binding.seat_id} (recorded turn: ${turnOf(binding.agent_id)}); pass --force to close a hung agent`
                : `liveness_unobservable: txd cannot observe an engine for this agent at ${binding.seat_id} and cannot prove it dead — the seat may run its engine beyond this machine, or the observation itself failed (recorded turn: ${turnOf(binding.agent_id)}); pass --force to close it anyway`,
            });
            continue;
          }
          await closeOne(target, binding);
          closedSeats.add(binding.seat_id);
        }
      } else {
        // Filtered selection is inherently graceful: recorded-idle (or stopped)
        // registered agents only — never an overseer or a mid-birth
        // (unregistered) binding, whose death is registration
        // abort's story.
        const candidates = proj.currentBindings.filter((b) => {
          if (!b.agent_id || !b.registered) return false;
          if (b.rank === CLOSE_REQUIRED_RANK) return false;
          if (turnOf(b.agent_id) === 'working') return false;
          return !req.page || b.seat_id.split(':', 1)[0] === req.page;
        });
        // The fold narrows the candidates; the probe decides. A filtered close
        // names no seat, so it carries no authorization to end a live agent.
        const observed = await Promise.all(candidates.map((b) => closable(b)));
        const selected = candidates.filter((_, index) => observed[index]!.may);
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
    let reaped: boolean;
    if (isStackSeat(binding.seat_id)) {
      await this.tmux.killSeat(binding.seat_id);
      reaped = !(await this.tmux.listSeats()).some((seat) =>
        seat.seat_id === binding.seat_id && seat.pane === 'live',
      );
    } else {
      reaped = await this.tmux.reapSeat(binding.seat_id, binding.tint);
    }
    if (!reaped) return false;
    const occurred_at = this.now();
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.agent_id) {
      inputs.push({ entity_type: 'agent', entity_id: binding.agent_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    }
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { agent_id: binding.agent_id }, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_cleared', payload: {}, provenance: prov, occurred_at });
    if (isStackSeat(binding.seat_id)) {
      inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_decommissioned', payload: {}, provenance: prov, occurred_at });
    }
    await this.store.appendAll(inputs);
    await this.publishRetirements([binding], 'close', occurred_at, signalUnregistered);
    // The seat is now cleared, and if it is one the estate keeps staffed the
    // vacancy is announced rather than filled: registrationd mints the next
    // agent's identity and dispatches it back here. Staffing the seat from
    // this line is what produced panes with no AGENT_ID in them — an agent
    // that cannot say who it is to any surface that asks.
    const perpetualEngine = this.physicalRegistration?.perpetual[binding.seat_id];
    if (perpetualEngine) {
      await this.physicalRegistration!.publish('agent.perpetual_seat_vacant', PerpetualSeatVacantSchema.parse({
        schema_version: AGENT_SCHEMA_VERSION,
        machine: this.physicalRegistration!.machine,
        seat_id: binding.seat_id,
        engine: perpetualEngine,
      }));
    }
    return true;
  }

  // ── stop ingestion — projected from lifecycled's agent journal facts ──────
  // Three honest outcomes, no blind swallow: record a fresh stop (bound + live),
  // dedupe a repeat/late stop (act.receipt_deduped), or REFUSE a ghost — a stop for
  // an id that never walked through /agents/launch. The ghost is refused at
  // admission, so nothing is recorded. The stop-hook is a REAL but UNTRUSTED
  // witness; lifecycled publishes the correlated agent journal fact and txd
  // folds only the turn axis.
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

      const turn = proj.turnByAgent.get(req.agent_id) ?? null;
      const stillBound = proj.currentBindings.some((b) => b.agent_id === req.agent_id);
      // Dedupe: already stopped/retired, or already closed (no longer bound) →
      // idempotent, but RECORDED as receipt_deduped (never a blind swallow).
      if (turn === 'awaiting_input' || turn === 'retired' || !stillBound) {
        await this.store.append({
          entity_type: 'agent',
          entity_id: req.agent_id,
          event_type: 'act.receipt_deduped',
          payload: { of: 'stop_reported', reason: turn ?? 'unbound' },
          provenance: this.prov('observer', transportReceipt),
          occurred_at: this.now(),
        });
        return { ok: true, agent_id: req.agent_id, recorded: false, deduped: true, turn };
      }

      // Fresh stop for a live, bound agent → record it (turn → awaiting_input).
      await this.store.append({
        entity_type: 'agent',
        entity_id: req.agent_id,
        event_type: 'act.stop_reported',
        payload: {},
        provenance: this.prov('hook', transportReceipt),
        occurred_at: this.now(),
      });

      return { ok: true, agent_id: req.agent_id, recorded: true, deduped: false, turn: 'awaiting_input' };
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
      for (const row of proj.seatBoard) {
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
      for (const row of proj.seatBoard) {
        if (row.seat_id === null) continue; // board row without a seat can't be a seat-liveness contradiction
        if (row.turn === 'retired' && observedPane.get(row.seat_id) === 'live') {
          await flag(row.seat_id, 'retired_pane_live', 'process_reaped', `turn=retired but tmux pane is live`);
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
        agents: proj.seatBoard.length,
        new_contradictions: newContradictions,
        open_contradictions: openContradictions,
        p0,
      };
    });
    if (councilRebuilt) await this.announceVacantPerpetualSeats();
    return response;
  }

  abandonSeats(
    req: EstateAbandonRequest,
    transportReceipt: string | null = null,
  ): Promise<EstateAbandonResponse> {
    return this.locked(async () => {
      const refused = (reason: string): EstateAbandonResponse => ({
        ok: false, abandoned: [], reason,
      });
      if (req.schema_version !== SCHEMA_VERSION) {
        return refused(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}, request sent ${req.schema_version}`);
      }
      const proj = await this.projections();
      const source = proj.currentBindings.find((binding) =>
        binding.registered && binding.agent_id === req.source_agent_id);
      if (!source || source.rank !== CLOSE_REQUIRED_RANK) {
        return refused(`not_authorized: estate abandon requires rank ${CLOSE_REQUIRED_RANK}`);
      }
      const observedSeats = new Set((await this.tmux.listSeats()).map((seat) => seat.seat_id));
      for (const seat of req.seats) {
        if (TXD_ESTATE.includes(seat)) return refused(`canonical_seat_requires_reconstruction: ${seat}`);
        const row = proj.seatBoard.find((candidate) => candidate.seat_id === seat);
        if (!row || row.binding !== 'unbound') return refused(`seat_not_projected_unbound: ${seat}`);
        if (observedSeats.has(seat)) return refused(`seat_still_observed: ${seat}`);
        const contradiction = proj.openContradictions.find((candidate) =>
          candidate.entity_id === seat
          && candidate.kind === 'pane_absent'
          && candidate.missing_attestation === 'seat_decommissioned');
        if (!contradiction) return refused(`seat_not_flagged_absent: ${seat}`);
      }
      const occurred_at = this.now();
      const provenance = this.prov('wrapper', transportReceipt);
      await this.store.appendAll(req.seats.map((seat) => ({
        entity_type: 'seat' as const,
        entity_id: seat,
        event_type: 'reg.seat_decommissioned',
        payload: { contradiction: 'pane_absent' },
        provenance,
        occurred_at,
      })));
      return { ok: true, abandoned: [...req.seats], reason: null };
    });
  }

  // ── Read model (spec §7 rung 6, reshaped [[txd-extraction-spec]] §6) ────────
  // The estate observation view behind `GET /tmux/read/estate` — txd's ONLY
  // public read surface. Per-entity event history is NOT served publicly:
  // the stream stays private replay/reconcile truth (biography serving is not
  // txd's job).
  async estateRows(): Promise<SeatBoardRow[]> {
    return (await this.projections()).seatBoard;
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

  /**
   * Announce every perpetual seat the estate is currently not staffing. txd
   * owns where an agent sits and can see that a declared seat is empty; it
   * does not own who arrives to fill it, so it says the seat is vacant and
   * registrationd answers with a dispatch. This sweep is also the
   * reconciliation for a vacancy nobody acted on: an announcement lost to a
   * crash is re-announced the next time txd starts.
   */
  async announceVacantPerpetualSeats(): Promise<void> {
    if (!this.physicalRegistration) return;
    return this.locked(async () => {
      const publish = this.physicalRegistration!.publish;
      const machine = this.physicalRegistration!.machine;
      const projections = await this.projections();
      const workloads = new Map((await this.tmux.workloads()).map((row) => [row.seat_id, row]));
      for (const [seatId, engine] of Object.entries(this.physicalRegistration!.perpetual)) {
        if (!TXD_ESTATE.includes(seatId)) {
          throw new Error(`perpetual pane is outside the canonical estate: ${seatId}`);
        }
        if (projections.currentBindings.some((binding) => binding.seat_id === seatId)) continue;
        const workload = workloads.get(seatId);
        if (workload && !workload.idle) continue;
        await publish('agent.perpetual_seat_vacant', PerpetualSeatVacantSchema.parse({
          schema_version: AGENT_SCHEMA_VERSION,
          machine,
          seat_id: seatId,
          engine,
        }));
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
    if (result.ok) await this.announceVacantPerpetualSeats();
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
      // The pane processes are replaced: any shell run staged in them lost
      // the shell that would signal its completion. Fail those runs loud now.
      for (const seat of seats) this.abortPaneRuns(seat);
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
    if (result.ok && result.reconstructed) await this.announceVacantPerpetualSeats();
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
    // The whole server dies: every staged pane run's completion signal with it.
    for (const seatId of this.paneRuns.keys()) this.abortPaneRuns(seatId);
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
    const estate_generation = await this.tmux.estateGeneration();
    const activation_pending = estate_generation === 'foreign';
    const open = proj.openContradictions.length;
    const tints = await this.tintReadiness();
    return {
      ok: open === 0
        && tmux_reachable
        && (activation_pending || tints.every((tint) => tint.state === 'ready')),
      service: 'txd' as const,
      schema_version: SCHEMA_VERSION,
      version: build.version,
      git_sha: build.git_sha,
      bun: build.bun,
      machine,
      events: await this.store.count(),
      open_contradictions: open,
      tmux_reachable,
      estate_generation,
      activation_pending,
      tints,
    };
  }
}

export type { EventInput };
