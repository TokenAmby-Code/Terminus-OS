// Daemon core — the domain logic behind the API (spec §4, §5, §6).
//
// Single writer: every mutating path runs under one async mutex so seq order
// and read-modify-write sequences never interleave. Truth is the event stream;
// this class only APPENDS facts and folds each committed record into its
// maintained projection. Boot and explicit log rewrites rebuild from replay.

import {
  SCHEMA_VERSION,
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
  type CommLogicalIdentity,
  type CommRequest,
  type LifecycleCommEffectRequest,
  type LifecycleCommEffectResponse,
  type CommReceiptWaitRequest,
  type CommReceipt,
  type CommTarget,
  type CommWaitRequest,
  type CommWaitResponse,
  type CurrentBinding,
  type EventInput,
  type EventLogCompactionRequest,
  type EventRecord,
  type EstateRotateRequest,
  type EstateRotateResponse,
  type EstateAbandonRequest,
  type EstateAbandonResponse,
  type LaunchRequest,
  type LaunchResponse,
  type ModeTransitionRequest,
  type ModeTransitionResponse,
  type OpenContradiction,
  type Provenance,
  type ProvenanceSource,
  type ReconcileResponse,
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
  CLIPBOARD_BUFFER_NAME,
  MAX_CLIPBOARD_BYTES,
} from '@terminus-os/contracts';
import {
  AGENT_SCHEMA_VERSION,
  AgentSchema,
  PLACEMENT_REFUSAL_REASONS,
  type RetirementCause,
  type SeatDisqualifier,
  type WrapperStartHook,
} from '@tokenamby-code/agent-contract/agent';
import {
  AgentRetiredSchema,
  DispatchAttestedSchema,
  DispatchRefusedSchema,
  EstateOccupancyCensusSchema,
  PaneAttestedSchema,
  PaneRefusedSchema,
  PerpetualSeatVacantSchema,
  PhysicalDeclarationSchema,
  PlacementAttestedSchema,
  PlacementRefusedSchema,
  RegistrationAbortedSchema,
  UnregisteredClosedSchema,
  type DispatchRefused,
  type DispatchRequested,
  type PhysicalDeclaration,
  type RegistrationAborted,
} from '@tokenamby-code/agent-contract/events';
import { journalEventSeqFromReceipt } from './journal-receipt.ts';
import { createHash } from 'node:crypto';
import type { EventStore } from './store.ts';
import type { EventLogCompactionResult } from './event-log-compaction.ts';
import { findTmuxId } from './ids.ts';
import {
  buildProjections,
  isRoutableBinding,
  routableBindings,
  type Projections,
  type LaunchComposition,
  type TransportClaim,
} from './projections.ts';
import {
  isStackPage,
  isStackSeat,
  isTxdPage,
  TXD_ESTATE,
  TXD_WINDOWS,
  type TxdPage,
  type TxdStackPage,
} from './estate.ts';
import {
  acceptCommIdentity,
  COUNCIL_ROSTER,
  sameIdentity,
  type AcceptedCommIdentity,
} from './comm-identity.ts';
import { attributedCommFrame, commFrame, commTokenForMessageId, type CommFrameSource } from './comm-frame.ts';
import type { SshSeatTargets } from './config.ts';
import { ENVELOPE_PREFIX, envelopeSessionName, type RemoteEnvelopeLister } from './envelopes.ts';
import { NOOP_ROTATION_BARRIER, type EstateRotationBarrier } from './rotation-lock.ts';
import type { TmuxControlPlane } from './tmux.ts';
import type { ClipboardOriginOutcome } from './clipboard-origin.ts';
import type { TxdPublishedEventType } from './events.ts';

// Reg-audit attestation set DEFINED SO FAR (door step 1). The refusal machinery
// is day-one; later doors grow this list as they add witnesses (rank, commander,
// singleton, dispatch_target become required when their witnesses walk in).
export const DOOR1_REQUIRED_ATTESTATIONS = ['identity', 'persona', 'tint'] as const;

type Now = () => string;
// What txd hands lifecycled to arm one comm watch: enough to name the
// subscription's agent stream and the message whose hook will assert delivery.
/**
 * A gate call that never reached lifecycled (or never heard it answer): the
 * transport failed or its ceiling expired. Distinct from a typed domain
 * refusal, which is lifecycled affirmatively answering that the gate is not
 * open. The daemon's gate closure throws this class for fetch-level failures
 * so the comm path can tell the two apart.
 */
export class CommGateTransportFailure extends Error {
  readonly reason: 'transport_ceiling_exceeded' | 'transport_failed';

  constructor(message: string) {
    super(message);
    this.reason = message.endsWith('_transport_ceiling_exceeded')
      ? 'transport_ceiling_exceeded'
      : 'transport_failed';
  }
}

export type CommWatchArmInput = {
  message_id: string;
  target_agent_id: string;
  source_agent_id: string;
  composer_interactive_observed: boolean;
};
export type ComposerGateInput = { correlation_id: string; target_agent_id: string };
/** One staged idle-target receipt's lost-Enter watch, armed at its tier-1 deadline. */
type LostEnterArm = {
  messageId: string;
  targetAgentId: string;
  seatId: string;
  frame: string;
  paneGeneration: string;
  receiptSeq: number;
  deadlineAt: number;
};
export type CommReceiptRuntime = {
  now: () => number;
  schedule: (wake: () => void, delayMs: number) => () => void;
};
export type CommAdmission = Pick<CommAccepted,
  'ok' | 'message_id' | 'ask_id' | 'source_agent_id' | 'targets' | 'event_ids'>;
type InternalComm = {
  messageId: string;
  sourceAgentIdInFrame: string;
  expectedSourceBoundSeq: number;
  expectedTargetAgentId: string;
  expectedTargetBoundSeq: number;
  lifecycleEffect: {
    effect_id: string;
    source_birth_generation: string;
    source_pane_generation: string;
    target_birth_generation: string;
    target_pane_generation: string;
  };
};
type ResolvedCommTarget = CommTarget & { logical_identity: CommLogicalIdentity };
const DEFAULT_COMM_RECEIPT_RUNTIME: CommReceiptRuntime = {
  now: () => Date.now(),
  schedule: (wake, delayMs) => {
    const timer = setTimeout(wake, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

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


function committedTransportBytes(outcome: { bytes: number; verdict: string }): number {
  return outcome.verdict === 'seat_unresolved' ? 0 : outcome.bytes;
}

export class Daemon {
  private mutex: Promise<unknown> = Promise.resolve();
  private maintainedProjection: Projections | null = null;
  private maintainedProjectionSeq = 0;
  private maintainedEvents: EventRecord[] = [];
  private projectionInitialized = false;
  private projectionEventsDuringFold: EventRecord[] = [];
  private projectionReady: Promise<void>;
  private openScopedResets = new Map<string, string[]>();
  private commWaiters = new Map<string, Set<() => void>>();
  private commTransportsInFlight = new Set<string>();
  private commTransportWaiters = new Map<string, Set<() => void>>();
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
  ) {
    // Install the commit observer before taking the boot snapshot. An append
    // racing that SELECT is either present in the snapshot or queued by seq;
    // it can never fall between the two and disappear from the fold.
    this.store.onAppend((event) => {
      if (!this.projectionInitialized) {
        this.projectionEventsDuringFold.push(event);
        return;
      }
      this.applyProjectionEvent(event);
    });
    this.projectionReady = this.rebuildProjection();
  }

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
      const pendingResetSeats = this.pendingScopedResetSeats();
      const projections = await this.projections();
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
        if (projections.abandonedSeats.has(candidate)) return 'abandoned';
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
      const abandonMintedStackSeat = async (): Promise<void> => {
        if (!mintedStackSeat) return;
        const seat = mintedStackSeat;
        await this.tmux.killSeat(seat);
        if ((await this.tmux.listSeats()).some((row) => row.seat_id === seat && row.pane === 'live')) {
          throw new Error(`txd could not verify minted stack seat cleanup for ${seat}`);
        }
        await this.store.append({
          entity_type: 'seat',
          entity_id: seat,
          event_type: 'reg.seat_abandoned',
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
          await abandonMintedStackSeat();
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
              abandoned: 'seat_abandoned',
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
          await abandonMintedStackSeat();
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
          await abandonMintedStackSeat();
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
        await abandonMintedStackSeat();
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

  activateRegisteredAgent(input: unknown): Promise<void> {
    return this.locked(async () => {
      const agent = AgentSchema.parse(input);
      if (!this.physicalRegistration) throw new Error('physical_registration_unconfigured');
      if (!agent.placement) throw new Error('registered_agent_physical_conflict');
      const projections = await this.projections();
      const binding = projections.currentBindings.find(
        (candidate) => candidate.agent_id === agent.incarnation.agent_id,
      );
      if (!binding
          || binding.birth_generation !== agent.incarnation.birth_generation
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
        entity_id: agent.incarnation.agent_id,
        event_type: 'reg.agent_registered',
        payload: {
          birth_generation: agent.incarnation.birth_generation,
          ticket_id: agent.ticket_id,
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
    const execute = async () => {
      await this.projectionReady;
      return fn();
    };
    const run = this.mutex.then(execute, execute);
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
    await this.projectionReady;
    return this.maintainedProjection!;
  }

  /** Read-only health/inspect access to the same fold every daemon reader uses. */
  async observationProjection(): Promise<Projections> {
    return this.projections();
  }

  private pendingScopedResetSeats(): Set<string> {
    return new Set([...this.openScopedResets.values()].flat());
  }

  private projectionCheckpoint(): EventRecord {
    const projection = this.maintainedProjection!;
    return {
      seq: this.maintainedProjectionSeq,
      entity_type: 'estate',
      entity_id: 'maintained-projection',
      event_type: 'estate.compaction_checkpoint',
      payload: {
        current_bindings: projection.currentBindings,
        seat_board: projection.seatBoard,
        open_contradictions: projection.openContradictions,
        turn_by_agent: [...projection.turnByAgent],
        ever_bound_agents: [...projection.everBoundAgents],
        physical_declarations: [...projection.physicalDeclarations.values()],
        placement_attested_agents: [...projection.placementAttestedAgents],
        abandoned_seats: [...projection.abandonedSeats],
        launch_compositions: [...projection.launchCompositions.values()],
        transport_claims: [...projection.transportClaims.values()],
      },
      provenance: { source: 'observer', transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: this.now(),
      recorded_at: this.now(),
    };
  }

  private foldScopedReset(event: EventRecord): void {
    if (event.event_type === 'estate.scoped_reset_requested') {
      const seats = Array.isArray(event.payload.seats)
        ? event.payload.seats.filter((seat): seat is string => typeof seat === 'string')
        : [];
      this.openScopedResets.set(event.entity_id, seats);
    } else if (event.event_type === 'estate.scoped_reset_completed'
      || event.event_type === 'estate.scoped_reset_failed') {
      this.openScopedResets.delete(event.entity_id);
    }
  }

  private applyProjectionEvent(event: EventRecord): void {
    this.maintainedProjection = buildProjections([this.projectionCheckpoint(), event]);
    this.maintainedProjectionSeq = Math.max(this.maintainedProjectionSeq, event.seq);
    this.maintainedEvents.push(event);
    this.foldScopedReset(event);
  }

  private async rebuildProjection(): Promise<void> {
    this.projectionInitialized = false;
    const events = await this.store.readAll();
    this.maintainedProjection = buildProjections(events);
    this.maintainedProjectionSeq = Math.max(0, ...events.map((event) => event.seq));
    this.maintainedEvents = [...events];
    this.openScopedResets.clear();
    for (const event of events) this.foldScopedReset(event);
    const appended = this.projectionEventsDuringFold
      .filter((event) => event.seq > this.maintainedProjectionSeq)
      .sort((left, right) => left.seq - right.seq);
    this.projectionEventsDuringFold = [];
    for (const event of appended) this.applyProjectionEvent(event);
    this.projectionInitialized = true;
  }

  private async events(): Promise<EventRecord[]> {
    await this.projectionReady;
    return this.maintainedEvents;
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
    const events = await this.events();
    const closed = new Set(events.flatMap((event) => {
      if (event.event_type === 'reg.binding_aborted' && typeof event.payload.prepare_id === 'string') {
        return [event.payload.prepare_id];
      }
      if (event.event_type === 'reg.bound' && typeof event.payload.binding_prepare_id === 'string') {
        return [event.payload.binding_prepare_id];
      }
      return [];
    }));
    const currentSeats = new Set((await this.projections()).currentBindings.map((binding) => binding.seat_id));
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
    const events = await this.events();
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
      const resetEvents = await this.events();
      const inputs = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, null, occurred_at, resetEvents),
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
      this.wakeCommDeliveryFailures(inputs);
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

  async clipboardSelection(req: ClipboardSelectionRequest): Promise<{ buffer_name: typeof CLIPBOARD_BUFFER_NAME } & ClipboardOriginOutcome> {
    return this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const result = await this.tmux.commitClipboardSelection(req.content, req.client_tty);
      return { buffer_name: CLIPBOARD_BUFFER_NAME, ...result };
    });
  }

  // Casing is folded here, at the comparison, and nowhere else: the target a
  // caller names is matched case-insensitively, and the identity that comes
  // back is the binding's own — canonical by construction.
  private perpetualSeatIds(): readonly string[] {
    return this.physicalRegistration
      ? Object.keys(this.physicalRegistration.perpetual)
      : COUNCIL_ROSTER;
  }

  private acceptLogicalCommIdentity(raw: string): AcceptedCommIdentity {
    return acceptCommIdentity(raw, this.perpetualSeatIds());
  }

  private identityBindings(identity: AcceptedCommIdentity, proj: Projections) {
    const candidates = routableBindings(proj);
    return identity.kind === 'stable_seat'
      ? candidates.filter((binding) => sameIdentity(binding.seat_id, identity.seat_id))
      : candidates.filter((binding) =>
        sameIdentity(binding.agent_id, identity.identity)
        || (binding.persona !== null && sameIdentity(binding.persona, identity.identity))
        || sameIdentity(binding.seat_id, identity.identity));
  }

  private commTargets(identity: AcceptedCommIdentity, proj: Projections): ResolvedCommTarget[] {
    return this.identityBindings(identity, proj).map((binding) => ({
      agent_id: binding.agent_id,
      seat_id: binding.seat_id,
      persona: binding.persona,
      logical_identity: identity.kind === 'stable_seat'
        ? identity
        : { kind: 'agent_instance', agent_id: binding.agent_id },
    }));
  }

  // Arm the delivery watch and composer gate BEFORE bytes go to the pane.
  //
  // Delivery attempts come first. A client ceiling elapsed only after
  // lifecycled held the request for its full server-owned gate contract; it is
  // not evidence that the already-created watch is unarmed, so bytes proceed
  // and delivery remains unresolved until an effect fact arrives. An earlier
  // transport failure still records the unarmed gap: an observed-interactive
  // composer may proceed, while an unpainted newborn keeps its hard stop. A
  // typed domain refusal is an affirmative answer and refuses as before.
  private async armCommWatch(
    messageId: string,
    sourceAgentId: string,
    targetAgentId: string,
    transportReceipt: string | null,
  ): Promise<void> {
    if (!this.commWatchArm) return;
    const composerInteractiveObserved = await this.backfillComposerInteractivity(targetAgentId, transportReceipt);
    try {
      await this.commWatchArm({
        message_id: messageId,
        target_agent_id: targetAgentId,
        source_agent_id: sourceAgentId,
        composer_interactive_observed: composerInteractiveObserved,
      });
    } catch (error) {
      if (error instanceof CommGateTransportFailure
        && error.reason === 'transport_ceiling_exceeded') return;
      await this.locked(() => this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'act.comm_watch_unarmed',
        payload: { message_id: messageId, target_agent_id: targetAgentId, detail: String(error) },
        provenance: this.prov('observer', transportReceipt), occurred_at: this.now() }));
      if (error instanceof CommGateTransportFailure && composerInteractiveObserved) return;
      throw error;
    }
  }

  private async backfillComposerInteractivity(
    targetAgentId: string,
    transportReceipt: string | null,
  ): Promise<boolean> {
    if (!this.physicalRegistration) return false;
    const observation = await this.locked(async () => {
      const events = await this.events();
      const projections = await this.projections();
      const binding = routableBindings(projections).find((row) => row.agent_id === targetAgentId);
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
        const events = await this.events();
        const projections = await this.projections();
        const current = projections.currentBindings.find((row) =>
          isRoutableBinding(row, projections)
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
        const events = await this.events();
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

  async comm(
    req: CommRequest,
    transportReceipt: string | null = null,
    onAccepted?: (admission: CommAdmission) => void,
    internal?: InternalComm,
  ): Promise<CommAccepted & { replayed?: boolean }> {
    const prepared = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      const sourceBindings = routableBindings(proj).filter((binding) =>
        binding.agent_id === req.source_agent_id);
      if (sourceBindings.length === 0) throw new Error('source_not_registered');
      // The frame names its sender as persona AND seat. A persona alone is not
      // a key — several seats may wear one — so a source whose identity cannot
      // be pinned to exactly one seat, or whose seat carries no persona,
      // refuses here rather than stage a frame that misattributes itself.
      if (sourceBindings.length !== 1) throw new Error('source_identity_ambiguous');
      const sourceBinding = sourceBindings[0]!;
      if (internal && sourceBinding.bound_seq !== internal.expectedSourceBoundSeq) {
        throw new Error('source_binding_changed');
      }
      if (!sourceBinding.persona) throw new Error('source_persona_unresolved');
      const source: CommFrameSource = { persona: sourceBinding.persona, seat_id: sourceBinding.seat_id };
      const events = await this.events();
      // The funnel mouth. A caller-supplied identity is softened to its
      // canonical form exactly once, here; `--self` and `--reply` name an
      // agent id txd itself recorded, which is canonical already.
      let targetIdentity: AcceptedCommIdentity | undefined = req.target === '--self'
        ? { kind: 'binding', identity: req.source_agent_id }
        : req.target === undefined ? undefined : this.acceptLogicalCommIdentity(req.target);
      let replyingToAsk: string | null = null;
      if (req.reply) {
        const inbound = [...events].reverse().find((e) => e.event_type === 'reg.comm_accepted'
          && Array.isArray(e.payload.target_agent_ids)
          && e.payload.target_agent_ids.includes(req.source_agent_id));
        if (!inbound) throw new Error('no_recent_inbound_sender');
        const inboundSource = inbound.payload.source as { seat_id?: unknown } | undefined;
        const sourceSeatId = typeof inboundSource?.seat_id === 'string' ? inboundSource.seat_id : null;
        targetIdentity = sourceSeatId && this.perpetualSeatIds().some((seatId) => sameIdentity(seatId, sourceSeatId))
          ? { kind: 'stable_seat', seat_id: sourceSeatId }
          : { kind: 'binding', identity: String(inbound.payload.source_agent_id) };
        replyingToAsk = typeof inbound.payload.ask_id === 'string' ? inbound.payload.ask_id : null;
      }
      let targets: ResolvedCommTarget[];
      if (req.page) {
        targets = routableBindings(proj)
          .filter((b) => b.seat_id.split(':', 1)[0] === req.page)
          .map((b) => ({
            agent_id: b.agent_id,
            seat_id: b.seat_id,
            persona: b.persona,
            logical_identity: { kind: 'agent_instance', agent_id: b.agent_id },
          }));
        if (targets.length === 0) throw new Error(`page_absent: ${req.page}`);
      } else {
        targets = this.commTargets(targetIdentity!, proj);
        const canonicalIdentity = targetIdentity!.kind === 'stable_seat'
          ? targetIdentity!.seat_id
          : targetIdentity!.identity;
        if (targets.length === 0) throw new Error(`identity_absent: ${canonicalIdentity}`);
        if (targets.length > 1) throw new Error(AMBIGUOUS_IDENTITY(canonicalIdentity));
      }
      if (internal) {
        const target = targets[0];
        const targetBinding = target && routableBindings(proj).find((binding) =>
          binding.agent_id === target.agent_id && binding.seat_id === target.seat_id);
        if (target?.agent_id !== internal.expectedTargetAgentId
          || targetBinding?.bound_seq !== internal.expectedTargetBoundSeq) {
          throw new Error(`target_binding_changed: ${internal.expectedTargetAgentId}`);
        }
      }
      const pendingResetSeats = this.pendingScopedResetSeats();
      const fenced = targets.find((target) => pendingResetSeats.has(target.seat_id));
      if (fenced) throw new Error(`scoped_reset_pending: ${fenced.seat_id}`);
      const intentBinding = req.intent
        ? routableBindings(proj).find((binding) => binding.agent_id === targets[0]?.agent_id)
        : null;
      if (req.intent && !intentBinding?.engine) throw new Error(`target_engine_unresolved: ${targets[0]?.agent_id}`);
      const renderedIntent = req.intent ? renderCommIntent(req.intent, intentBinding!.engine!) : null;
      const messageId = internal?.messageId ?? crypto.randomUUID();
      const askId = req.ask ? crypto.randomUUID() : null;
      const occurred_at = this.now();
      const renderedMessageFrame = internal
        ? attributedCommFrame(messageId, source, internal.sourceAgentIdInFrame, req.message!)
        : null;
      const existing = events.find((event) => event.entity_id === messageId
        && event.event_type === 'reg.comm_accepted');
      if (existing) {
        let snapshot = events.find((event) => event.event_type === 'reg.comm_target_snapshotted'
          && event.payload.message_id === messageId);
        const persistedLifecycleEffect = existing.payload.lifecycle_effect as Record<string, unknown> | undefined;
        const sameEffect = internal
          && existing.payload.effect === 'lifecycle_comm'
          && existing.payload.source_agent_id === req.source_agent_id
          && existing.payload.message === req.message
          && persistedLifecycleEffect?.effect_id === internal.lifecycleEffect.effect_id
          && persistedLifecycleEffect?.source_birth_generation === internal.lifecycleEffect.source_birth_generation
          && persistedLifecycleEffect?.source_pane_generation === internal.lifecycleEffect.source_pane_generation
          && persistedLifecycleEffect?.target_birth_generation === internal.lifecycleEffect.target_birth_generation
          && persistedLifecycleEffect?.target_pane_generation === internal.lifecycleEffect.target_pane_generation
          && JSON.stringify(existing.payload.target_agent_ids) === JSON.stringify(targets.map((target) => target.agent_id));
        if (!sameEffect) throw new Error('comm_message_id_conflict');
        if (!snapshot) {
          snapshot = await this.store.append({
            entity_type: 'message',
            entity_id: messageId,
            event_type: 'reg.comm_target_snapshotted',
            payload: { message_id: messageId, targets: existing.payload.targets },
            provenance: this.prov('observer', transportReceipt),
            occurred_at: this.now(),
          });
        }
        const sent = events.filter((event) => event.entity_id === messageId
          && event.event_type === 'act.comm_bytes_sent');
        return {
          messageId,
          askId: null,
          replyingToAsk: null,
          source,
          targets,
          renderedIntent: null,
          renderedMessageFrame,
          eventIds: [existing.seq, snapshot.seq, ...sent.map((event) => event.seq)],
          replayed: true,
          replayComplete: sent.length === targets.length,
          replayStaged: sent.length === targets.length
            && sent.every((event) => event.payload.submit_verdict === 'staged'),
        };
      }
      const accepted = await this.store.append({ entity_type: 'message', entity_id: messageId, event_type: 'reg.comm_accepted', payload: {
        source_agent_id: req.source_agent_id, source, target_agent_ids: targets.map((t) => t.agent_id), targets,
        ask_id: askId, reply_to_ask_id: replyingToAsk,
        kind: req.intent?.kind ?? 'message',
        name: req.intent?.name ?? null,
        rendered_frame: renderedIntent?.frame ?? renderedMessageFrame,
        message: req.message ?? renderedIntent!.frame,
        ...(req.intent ? { intent: req.intent } : {}),
        ...(internal ? { effect: 'lifecycle_comm', lifecycle_effect: internal.lifecycleEffect } : {}),
      }, provenance: this.prov('wrapper', transportReceipt), occurred_at });
      const snapshot = await this.store.append({ entity_type: askId ? 'ask' : 'message', entity_id: askId ?? messageId,
        event_type: 'reg.comm_target_snapshotted', payload: { message_id: messageId, targets }, provenance: this.prov('observer', transportReceipt), occurred_at });
      return {
        messageId, askId, replyingToAsk, source, targets, renderedIntent, renderedMessageFrame,
        eventIds: [accepted.seq, snapshot.seq], replayed: false, replayStaged: false,
        replayComplete: false,
      };
    });

    if (prepared.replayed) {
      if (!prepared.replayComplete) {
        await this.terminalizeInactiveCommTransport(prepared.messageId);
        const events = await this.events();
        const sent = events.filter((event) => event.entity_id === prepared.messageId
          && event.event_type === 'act.comm_bytes_sent');
        prepared.eventIds.push(...sent.map((event) => event.seq)
          .filter((seq) => !prepared.eventIds.includes(seq)));
        prepared.replayStaged = sent.length === prepared.targets.length
          && sent.every((event) => event.payload.submit_verdict === 'staged');
      }
      return {
        ok: true,
        message_id: prepared.messageId,
        ask_id: null,
        source_agent_id: req.source_agent_id,
        targets: prepared.targets,
        staged: prepared.replayStaged,
        event_ids: prepared.eventIds,
        replayed: true,
      };
    }

    // The journaled admission is the sender's durable correlation handle.
    // Expose it immediately after persistence: every later step is transport
    // planning or effect, and none may strand an already-committed id.
    this.commTransportsInFlight.add(prepared.messageId);
    try {
      onAccepted?.({
        ok: true,
        message_id: prepared.messageId,
        ask_id: prepared.askId,
        source_agent_id: req.source_agent_id,
        targets: prepared.targets,
        event_ids: prepared.eventIds,
      });
    } catch (error) {
      // Admission is committed. A caller-side notification failure cannot
      // cancel the transport transaction it was only observing.
      console.error(JSON.stringify({
        level: 'error', event: 'comm_admission_observer_failed',
        message_id: prepared.messageId, error: String(error),
      }));
    }

    try {
      await Promise.all(prepared.targets.map((target) => {
        return this.armCommWatch(prepared.messageId, req.source_agent_id, target.agent_id, transportReceipt);
      }));

      const plans = await this.locked(async () => {
        const proj = await this.projections();
        if (internal && !proj.currentBindings.some((binding) => binding.registered
          && binding.agent_id === req.source_agent_id
          && binding.bound_seq === internal.expectedSourceBoundSeq)) {
          throw new Error('source_binding_changed');
        }
        const pendingResetSeats = this.pendingScopedResetSeats();
        for (const target of prepared.targets) {
          const binding = proj.currentBindings.find((row) => isRoutableBinding(row, proj)
            && row.agent_id === target.agent_id
            && row.seat_id === target.seat_id
            && (!internal || row.bound_seq === internal.expectedTargetBoundSeq));
          if (!binding) throw new Error(`target_binding_changed: ${target.agent_id}`);
          if (pendingResetSeats.has(target.seat_id)) throw new Error(`scoped_reset_pending: ${target.seat_id}`);
        }
        return prepared.targets.map((target) => {
          const binding = proj.currentBindings.find((row) => isRoutableBinding(row, proj)
            && row.agent_id === target.agent_id
            && row.seat_id === target.seat_id
            && (!internal || row.bound_seq === internal.expectedTargetBoundSeq))!;
          const frame = prepared.renderedIntent?.frame ?? prepared.renderedMessageFrame
            ?? commFrame(prepared.messageId, prepared.source, req.message!);
          // The target's turn state at send, stamped on the receipt: a frame
          // staged into a WORKING engine is queued into that turn, and only that
          // stamp lets the turn-stop join later read the receipt as consumable.
          return { target, binding, frame, target_turn: proj.turnByAgent.get(target.agent_id) ?? 'unobserved' };
        });
      });

    // Tmux repaint is an external wait. It must never hold the journal mutex:
    // UserPromptSubmit can arrive as soon as Enter is driven, and that hook is
    // the effect fact this transaction exists to record. Event 37076 proved
    // the old inversion: staging held this.locked for five minutes, edge-proxy
    // reached txd with the hook, and timed out before txd could admit it.
    const outcomes: Array<{ plan: typeof plans[number]; sent: Awaited<ReturnType<TmuxControlPlane['sendVerifiedToSeat']>> }> = [];
    for (const plan of plans) {
      // The binding's opaque pane generation is the physical transaction
      // witness. Re-attest immediately before mutation: a replaced/unreadable
      // pane refuses with zero effect instead of letting a stale logical seat
      // address type into whatever now occupies that name.
      let sent: Awaited<ReturnType<TmuxControlPlane['sendVerifiedToSeat']>>;
      try {
        const generation = await this.tmux.seatGeneration(plan.target.seat_id);
        sent = generation !== plan.binding.pane_generation
          ? { bytes: 0, verdict: 'seat_unresolved' as const }
          : await this.tmux.sendVerifiedToSeat(
            plan.target.seat_id,
            prepared.messageId,
            plan.frame,
            prepared.renderedIntent?.tabAfter,
            plan.binding.engine ?? undefined,
            plan.binding.pane_generation,
          );
      } catch {
        // Admission already committed. An adapter exception is therefore a
        // post-validation transport refusal, not permission to strand the
        // sender without a durable per-target verdict.
        sent = { bytes: 0, verdict: 'transport_failed' as const };
      }
      outcomes.push({ plan, sent });
    }

    const completionArms: LostEnterArm[] = [];
    let accepted: CommAccepted;
    try {
      accepted = await this.locked(async () => {
        const event_ids = [...prepared.eventIds];
        let allStaged = true;
        for (const { plan, sent } of outcomes) {
          const receiptDeadline = this.commReceiptRuntime.now() + COMM_DELIVERY_RECEIPT_TIMEOUT_MS;
          const event = await this.store.append({ entity_type: 'message', entity_id: prepared.messageId, event_type: 'act.comm_bytes_sent',
            payload: {
              target_agent_id: plan.target.agent_id, seat_id: plan.target.seat_id, bytes: committedTransportBytes(sent),
              submit_verdict: sent.verdict,
              target_turn: plan.target_turn,
              kind: req.intent?.kind ?? 'message',
              name: req.intent?.name ?? null, rendered_frame: plan.frame,
              receipt_deadline_at: new Date(receiptDeadline).toISOString(),
            }, provenance: this.prov('observer', transportReceipt), occurred_at: this.now() });
          event_ids.push(event.seq);
          allStaged &&= sent.verdict === 'staged';
          // The lost-Enter watch (live specimen 29fb6cc0). tmux exit 0 proves
          // the Enter was handed to the pane, never that the engine consumed
          // it. A staged frame in an AWAITING_INPUT engine whose Enter had no
          // effect fires no UserPromptSubmit and no later stop, so neither
          // existing join ever re-examines it. The receipt's own tier-1
          // deadline is the derived activation: one wake, one at-rest
          // observation, and only an exact intact frame completes its own
          // transaction. A WORKING target stays with the turn-stop join.
          // The binding's pane generation is the physical transaction witness;
          // without one there is nothing to re-attest against, so no watch.
          if (sent.verdict === 'staged' && plan.target_turn === 'awaiting_input'
            && plan.binding.pane_generation !== null) {
            completionArms.push({
              messageId: prepared.messageId,
              targetAgentId: plan.target.agent_id,
              seatId: plan.target.seat_id,
              frame: plan.frame,
              paneGeneration: plan.binding.pane_generation,
              receiptSeq: event.seq,
              deadlineAt: receiptDeadline,
            });
          }
          if (sent.verdict === 'staged') {
            const events = await this.events();
            // A command or skill surface submits with no comm envelope in the
            // prompt, so its hook carries an empty `message_ids` list and the
            // rendered frame is the only thing that names it. Enter is driven
            // outside the journal mutex, so that hook can land before this
            // receipt exists — the hook then sees no staged transport and
            // declines, and matching here by message id alone would lose the
            // delivery with both facts present.
            //
            // But a frame names an intent only while ONE intent carries it. Two
            // identical sends to one target share it byte for byte, and reading
            // such a hook as this message's would assert a delivery the engine
            // never made. The frame arm therefore holds only while this message
            // is the single intent wearing that frame for that target; ambiguity
            // falls back to the message-id join and stays undelivered.
            //
            // Uniqueness counts every ACCEPTED intent with that frame, including
            // ones already delivered. Counting only the undelivered would let the
            // set shrink as deliveries land: the first of two identical intents
            // asserts, the second becomes the lone survivor, and the spent hook
            // that named the first would then read as a unique witness for a
            // message the engine never submitted.
            const intentFrame = prepared.renderedIntent?.frame;
            const frameCandidates = intentFrame === undefined ? [] : events.filter((candidate) =>
              candidate.event_type === 'reg.comm_accepted'
              && (candidate.payload.kind === 'command' || candidate.payload.kind === 'skill')
              && candidate.payload.rendered_frame === intentFrame
              && Array.isArray(candidate.payload.target_agent_ids)
              && candidate.payload.target_agent_ids.includes(plan.target.agent_id));
            const frameNamesThisMessage = frameCandidates.length === 1
              && frameCandidates[0]!.entity_id === prepared.messageId;
            const submitted = events.some((candidate) => candidate.event_type === 'act.prompt_submitted'
              && candidate.payload.agent_id === plan.target.agent_id
              && ((Array.isArray(candidate.payload.message_ids)
                  && candidate.payload.message_ids.includes(prepared.messageId))
                || (plan.frame.includes(commTokenForMessageId(prepared.messageId))
                  && typeof candidate.payload.content === 'string'
                  && candidate.payload.content.includes(plan.frame))
                || (frameNamesThisMessage && candidate.payload.content === intentFrame)));
            const assertionId = `${prepared.messageId}:${plan.target.agent_id}`;
            if (submitted && !events.some((candidate) => candidate.entity_id === assertionId
              && candidate.event_type === 'act.comm_delivery_asserted')) {
              const assertion = await this.store.append({
                entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
                payload: {
                  message_id: prepared.messageId,
                  target_agent_id: plan.target.agent_id,
                  source_agent_id: req.source_agent_id,
                },
                provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
              });
              event_ids.push(assertion.seq);
              this.wakeDelivery(prepared.messageId);
            }
          }
        }
        if (prepared.replyingToAsk) await this.assertCallback(prepared.replyingToAsk, req.source_agent_id, req.message!, 'reply', null, transportReceipt);
        return { ok: true, message_id: prepared.messageId, ask_id: prepared.askId, source_agent_id: req.source_agent_id,
          targets: prepared.targets, staged: allStaged, event_ids };
      });
    } finally {
      // A receipt waiter must observe either the persisted rows or the
      // persistence failure; no post-admission completion path may leave it
      // asleep forever.
      this.commTransportsInFlight.delete(prepared.messageId);
      this.wakeCommTransport(prepared.messageId);
    }
    for (const arm of completionArms) {
      this.commReceiptRuntime.schedule(
        () => this.completeLostEnter(arm),
        Math.max(0, arm.deadlineAt - this.commReceiptRuntime.now()),
      );
    }
      return accepted;
    } catch (error) {
      // Any post-admission planning or transport failure must leave durable
      // per-target outcomes. Receipt readers can then return a typed refusal
      // for the admission id the sender already holds.
      this.commTransportsInFlight.delete(prepared.messageId);
      try {
        await this.terminalizeInactiveCommTransport(prepared.messageId);
      } finally {
        this.wakeCommTransport(prepared.messageId);
      }
      throw error;
    }
  }

  /**
   * The lost-Enter completion wake, fired once at the receipt's persisted
   * tier-1 deadline. It acts only on the full evidence chain — no delivery
   * assertion, no prior drive, the send-time binding still live on the same
   * pane generation, the target still at rest (a capture against a busy
   * engine proves nothing, specimen e5757301) — and then only when the tmux
   * plane observes the exact staged frame intact in the at-rest composer.
   * Driving Enter there completes the transport transaction that staged the
   * frame; delivery is still asserted exclusively by the engine's own
   * UserPromptSubmit. Every other observation is a zero-effect refusal that
   * leaves the message honestly undelivered.
   */
  private async completeLostEnter(arm: LostEnterArm): Promise<void> {
    const go = await this.locked(async () => {
      const events = await this.events();
      const assertionId = `${arm.messageId}:${arm.targetAgentId}`;
      if (events.some((event) => event.entity_id === assertionId
        && event.event_type === 'act.comm_delivery_asserted')) return false;
      if (events.some((event) => event.event_type === 'act.comm_submit_driven'
        && event.payload.message_id === arm.messageId
        && event.payload.target_agent_id === arm.targetAgentId)) return false;
      const proj = await this.projections();
      const binding = proj.currentBindings.find((row) => isRoutableBinding(row, proj)
        && row.agent_id === arm.targetAgentId
        && row.seat_id === arm.seatId
        && row.pane_generation === arm.paneGeneration);
      if (!binding) return false;
      return proj.turnByAgent.get(arm.targetAgentId) === 'awaiting_input';
    });
    if (!go) return;
    const outcome = await this.tmux.completeStagedSubmit(arm.seatId, arm.frame, arm.paneGeneration);
    if (outcome !== 'submit_completed' && outcome !== 'submit_failed') return;
    await this.locked(async () => {
      const events = await this.events();
      if (events.some((event) => event.event_type === 'act.comm_submit_driven'
        && event.payload.message_id === arm.messageId
        && event.payload.target_agent_id === arm.targetAgentId)) return;
      await this.store.append({
        entity_type: 'message', entity_id: arm.messageId, event_type: 'act.comm_submit_driven',
        payload: {
          message_id: arm.messageId,
          target_agent_id: arm.targetAgentId,
          seat_id: arm.seatId,
          transport_receipt_seq: arm.receiptSeq,
          frame_observation: 'frame_present',
          enter: outcome === 'submit_completed' ? 'driven' : 'failed',
        },
        provenance: this.prov('observer', null),
        occurred_at: this.now(),
      });
    });
  }

  async inject(req: { schema_version: number; target_agent_id: string; text: string }, transportReceipt: string | null = null) {
    const prepared = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      const proj = await this.projections();
      const binding = routableBindings(proj).find((row) => row.agent_id === req.target_agent_id);
      if (!binding) throw new Error(`target_unbound: ${req.target_agent_id}`);
      const correlationId = crypto.randomUUID();
      return { binding, correlationId };
    });
    if (!this.composerGate) throw new Error('composer_gate_unconfigured');
    await this.composerGate({ correlation_id: prepared.correlationId, target_agent_id: req.target_agent_id });

    return this.locked(async () => {
      const proj = await this.projections();
      const binding = proj.currentBindings.find((row) => isRoutableBinding(row, proj)
        && row.agent_id === req.target_agent_id && row.seat_id === prepared.binding.seat_id);
      if (!binding) throw new Error(`target_binding_changed: ${req.target_agent_id}`);
      const generation = await this.tmux.seatGeneration(binding.seat_id);
      const sent = generation !== binding.pane_generation
        ? { bytes: 0, verdict: 'seat_unresolved' as const }
        : await this.tmux.sendVerifiedToSeat(binding.seat_id, prepared.correlationId, req.text, undefined, binding.engine ?? undefined, binding.pane_generation);
      await this.store.append({ entity_type: 'message', entity_id: prepared.correlationId, event_type: 'act.agent_input_injected',
        payload: { target_agent_id: req.target_agent_id, seat_id: binding.seat_id, bytes: committedTransportBytes(sent), submit_verdict: sent.verdict, input_class: 'machine_feed' },
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
      const pendingResetSeats = this.pendingScopedResetSeats();
      const logicalIdentity = this.acceptLogicalCommIdentity(req.target);
      const matches = this.identityBindings(logicalIdentity, proj);
      if (matches.length > 1) throw new Error(AMBIGUOUS_IDENTITY(req.target));
      if (matches.length === 1) {
        const binding = matches[0]!;
        if (pendingResetSeats.has(binding.seat_id)) throw new Error(`scoped_reset_pending: ${binding.seat_id}`);
        if (!binding.agent_id || !binding.engine) throw new Error(`engine_unattested: ${req.target}`);
        return { kind: 'agent' as const, binding };
      }
      const bareSeatId = logicalIdentity.kind === 'stable_seat'
        ? logicalIdentity.seat_id
        : req.target;
      // No registered binding answers to this identity, so the only reading
      // left is a bare declared seat. Anything else is absent — loud.
      if (!TXD_ESTATE.includes(bareSeatId)) throw new Error(`identity_absent: ${req.target}`);
      if (proj.abandonedSeats.has(bareSeatId)) throw new Error(`seat_abandoned: ${bareSeatId}`);
      // A binding mid-birth is an agent arriving; racing its registration
      // with a shell line would type into its wrapper.
      if (proj.currentBindings.some((binding) => binding.seat_id === bareSeatId)) {
        throw new Error(`seat_binding_pending: ${bareSeatId}`);
      }
      if (pendingResetSeats.has(bareSeatId)) throw new Error(`scoped_reset_pending: ${bareSeatId}`);
      const row = proj.seatBoard.find((entry) => entry.seat_id === bareSeatId);
      if (row && row.pane === 'dead') throw new Error(`pane_dead: ${bareSeatId}`);
      return { kind: 'pane' as const, seatId: bareSeatId };
    });

    const runId = crypto.randomUUID();
    if (prepared.kind === 'agent') {
      const response = await this.locked(async (): Promise<RunAgentResponse> => {
        const proj = await this.projections();
        const binding = proj.currentBindings.find((row) => isRoutableBinding(row, proj)
          && row.agent_id === prepared.binding.agent_id && row.seat_id === prepared.binding.seat_id);
        if (!binding) throw new Error(`target_binding_changed: ${req.target}`);
        const generation = await this.tmux.seatGeneration(binding.seat_id);
        const sent = generation !== binding.pane_generation
          ? { bytes: 0, verdict: 'seat_unresolved' as const }
          : await this.tmux.runInAgentComposer(binding.seat_id, runId, req.command, binding.engine!, binding.pane_generation);
        // Payload holds dumb correlation facts only. The command LINE never
        // enters the append-only stream: like inject's text, it can carry
        // credentials, and an event cannot be redacted later — the digest
        // correlates without persisting the bytes.
        const event = await this.store.append({ entity_type: 'message', entity_id: runId, event_type: 'act.agent_input_injected',
          payload: {
            target_agent_id: binding.agent_id, seat_id: binding.seat_id, bytes: committedTransportBytes(sent),
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
      const matches = this.identityBindings(this.acceptLogicalCommIdentity(req.target), proj);
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
    const events = await this.events();
    const snapshot = events.find((e) => e.entity_id === askId && e.event_type === 'reg.comm_target_snapshotted');
    const targets = (snapshot?.payload.targets ?? []) as CommTarget[];
    if (!targets.some((t) => t.agent_id === targetAgent)) return;
    if (events.some((e) => e.event_type === 'act.comm_callback_asserted' && e.payload.ask_id === askId && e.payload.target_agent_id === targetAgent)) return;
    const accepted = events.find((e) => e.entity_id === snapshot?.payload.message_id && e.event_type === 'reg.comm_accepted');
    const subscriber = String(accepted?.payload.source_agent_id ?? '');
    // Callback identity belongs to the ask. One lifecycle stop may satisfy
    // several asks that were already open, but it cannot become a reusable
    // subscriber/target fact that future asks inherit.
    const assertionId = `${askId}:${targetAgent}`;
    if (events.some((e) => e.entity_id === assertionId && e.event_type === 'act.comm_callback_asserted')) return;
    await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_callback_asserted',
      payload: { ask_id: askId, subscriber_agent_id: subscriber, target_agent_id: targetAgent, content, source, stop_event_id: stopEventId }, provenance: this.prov('observer', receipt), occurred_at: this.now() });
    this.wakeAsk(askId);
  }

  /**
   * Every message whose staged frame the engine handed back inside the prompt
   * it submitted. This is the transport's own bytes observed leaving the
   * composer: txd wrote that exact frame into that exact seat, and the engine
   * returned it in a submission, so the delivery happened whatever the frame
   * parser could name.
   *
   * The parser reads a frame only where a frame begins its own line, which is
   * the right rule for reading an IDENTIFIER out of prose. It is the wrong rule
   * for reading an EFFECT: a composer that already held an operator draft
   * continues that draft's line with the pasted frame, and the whole thing is
   * submitted as one prompt. On 2026-08-19 that shape lost seven deliveries,
   * five of them addressed to Custodes — specimen 9dc15225, staged at event
   * 56994 and submitted 246ms later at event 56995 behind the words `im going
   * to wait until home from the gym to do the `.
   *
   * A quoted frame cannot forge this. The evidence is the receipt, not the
   * prompt: there must be a `staged` transport fact naming this agent.
   *
   * Only a SELF-NAMING frame qualifies — one carrying its own comm token, which
   * is every `message` comm and no `command`/`skill` intent. An intent frame
   * renders the surface call and nothing else, so two identical intents to one
   * target wear one frame byte for byte and containment could not tell them
   * apart; reading such a hook here would assert a delivery the engine never
   * made. Intents keep their own uniqueness-counted join and are left alone.
   */
  private stagedFrameDeliveries(events: EventRecord[], agentId: string, content: string | undefined): string[] {
    if (content === undefined) return [];
    const named = new Set<string>();
    for (const receipt of events) {
      if (receipt.event_type !== 'act.comm_bytes_sent'
        || receipt.payload.target_agent_id !== agentId
        || receipt.payload.submit_verdict !== 'staged') continue;
      const frame = receipt.payload.rendered_frame;
      if (typeof frame !== 'string') continue;
      let token: string;
      try { token = commTokenForMessageId(receipt.entity_id); }
      catch { continue; } // Non-UUID entities never staged a self-naming frame.
      if (!frame.includes(token)) continue;
      if (content.includes(frame)) named.add(receipt.entity_id);
    }
    return [...named];
  }

  /** Every sender blocked on a receipt for a comm this transaction just refused. */
  private wakeCommDeliveryFailures(inputs: readonly EventInput[]): void {
    for (const input of inputs) {
      if (input.event_type === 'act.comm_delivery_failed') this.wakeDelivery(String(input.payload.message_id));
    }
  }

  private wakeDelivery(messageId: string): void {
    for (const wake of this.deliveryWaiters.get(messageId) ?? []) wake();
    this.deliveryWaiters.delete(messageId);
  }

  private wakeCommTransport(messageId: string): void {
    for (const wake of this.commTransportWaiters.get(messageId) ?? []) wake();
    this.commTransportWaiters.delete(messageId);
  }

  /**
   * A committed admission with missing transport rows is terminal only when
   * no transport operation for it exists in this daemon. That condition is
   * what a restart proves: the former process cannot still complete pane I/O.
   * Persist the per-target refusal so later receipt reads remain durable.
   */
  private terminalizeInactiveCommTransport(messageId: string): Promise<void> {
    return this.locked(async () => {
      if (this.commTransportsInFlight.has(messageId)) return;
      const events = await this.events();
      const accepted = events.find((event) => event.entity_id === messageId
        && event.event_type === 'reg.comm_accepted');
      if (!accepted) return;
      const targets = (accepted.payload.targets ?? []) as CommTarget[];
      const receipted = new Set(events.filter((event) => event.entity_id === messageId
        && event.event_type === 'act.comm_bytes_sent')
        .map((event) => String(event.payload.target_agent_id)));
      for (const target of targets) {
        if (receipted.has(target.agent_id)) continue;
        const deadline = this.commReceiptRuntime.now() + COMM_DELIVERY_RECEIPT_TIMEOUT_MS;
        await this.store.append({
          entity_type: 'message', entity_id: messageId, event_type: 'act.comm_bytes_sent',
          payload: {
            target_agent_id: target.agent_id,
            seat_id: target.seat_id,
            bytes: 0,
            submit_verdict: 'transport_failed',
            target_turn: 'unobserved',
            kind: accepted.payload.kind ?? 'message',
            name: accepted.payload.name ?? null,
            rendered_frame: accepted.payload.rendered_frame ?? null,
            receipt_deadline_at: new Date(deadline).toISOString(),
            failure_reason: 'transport_process_ended',
          },
          provenance: this.prov('observer', null),
          occurred_at: this.now(),
        });
      }
    });
  }

  // One flush, every message it carried. A frame this agent was never a target
  // of belongs to someone else's correspondence and is skipped in silence; only
  // a flush that matched NOTHING is a refusal, so an ordinary prompt still
  // fails deterministically instead of wedging the lane.
  promptSubmitted(hook: CommHook, receipt: string | null = null): Promise<{ ok: true; asserted: string[]; dead_lettered: string[] }> {
    return this.locked(async () => {
      // The hook names frames by their compact comm tokens — the only identity
      // the frame carries. The event stream records canonical ids, so each
      // token resolves to its accepted message here, at the ingress, and an
      // unresolvable token simply names no correspondence of ours.
      const preEvents = await this.events();
      const acceptedByToken = new Map<string, string>();
      for (const event of preEvents) {
        if (event.event_type !== 'reg.comm_accepted') continue;
        try { acceptedByToken.set(commTokenForMessageId(event.entity_id), event.entity_id); }
        catch { /* Non-UUID fixtures and unrelated historical entities are not comm frames. */ }
      }
      const framedMessageIds = hook.comm_tokens.flatMap((token) => {
        const messageId = acceptedByToken.get(token);
        return messageId ? [messageId] : [];
      });
      await this.store.append({
        entity_type: 'agent', entity_id: hook.agent_id, event_type: 'act.prompt_submitted',
        payload: {
          agent_id: hook.agent_id,
          comm_tokens: hook.comm_tokens,
          message_ids: framedMessageIds,
          content: hook.content ?? null,
          session_id: hook.session_id ?? null,
        },
        provenance: this.prov('hook', receipt), occurred_at: this.now(),
      });
      const events = await this.events();
      const asserted: string[] = [];
      const matchedMessageIds: string[] = [];
      const confirmations = new Map<string, string[]>();
      let matched = false;
      // Same one-to-one rule as the staged-receipt join above, counted the same
      // stable way: a rendered frame identifies an intent only while exactly one
      // ACCEPTED intent wears it for this target, delivered ones included.
      // Taking the first of several identical frames — or letting the set shrink
      // as deliveries assert — would attribute one submission to a message the
      // engine never submitted, so an ambiguous frame yields no correlation and
      // the hook stays non-delivery evidence.
      const intentCandidates = hook.content === undefined ? [] : events.filter((event) =>
        event.event_type === 'reg.comm_accepted'
        && (event.payload.kind === 'command' || event.payload.kind === 'skill')
        && event.payload.rendered_frame === hook.content
        && Array.isArray(event.payload.target_agent_ids)
        && event.payload.target_agent_ids.includes(hook.agent_id));
      const intentMessage = intentCandidates.length === 1 ? intentCandidates[0] : undefined;
      const messageIds = [...new Set([
        ...framedMessageIds,
        ...(intentMessage ? [intentMessage.entity_id] : []),
        ...this.stagedFrameDeliveries(events, hook.agent_id, hook.content),
      ])];
      for (const messageId of messageIds) {
        const accepted = events.find((e) => e.entity_id === messageId && e.event_type === 'reg.comm_accepted');
        if (!accepted || !(accepted.payload.target_agent_ids as unknown[]).includes(hook.agent_id)) continue;
        // The snapshot is the delivery target contract — `commDelivery` reads
        // targets from it, so an assertion it cannot see must never be
        // written. Redemption requires the receiver in BOTH records.
        const snapshot = events.find((e) => e.event_type === 'reg.comm_target_snapshotted'
          && e.payload.message_id === messageId);
        const snapshotTargets = (snapshot?.payload.targets ?? []) as CommTarget[];
        if (!snapshotTargets.some((target) => target.agent_id === hook.agent_id)) continue;
        matched = true;
        const staged = events.some((event) => event.entity_id === messageId
          && event.event_type === 'act.comm_bytes_sent'
          && event.payload.target_agent_id === hook.agent_id
          && event.payload.submit_verdict === 'staged');
        if (!staged) continue;
        const assertionId = `${messageId}:${hook.agent_id}`;
        if (events.some((event) => event.entity_id === assertionId
          && event.event_type === 'act.comm_delivery_asserted')) {
          await this.store.append({
            entity_type: 'assertion',
            entity_id: assertionId,
            event_type: 'act.receipt_deduped',
            payload: {
              of: 'comm_delivery_asserted',
              reason: 'already_asserted',
              message_id: messageId,
              target_agent_id: hook.agent_id,
            },
            provenance: this.prov('observer', receipt),
            occurred_at: this.now(),
          });
          continue;
        }
        matchedMessageIds.push(messageId);
        await this.store.append({ entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
          payload: { message_id: messageId, target_agent_id: hook.agent_id, source_agent_id: accepted.payload.source_agent_id }, provenance: this.prov('hook', receipt), occurred_at: this.now() });
        asserted.push(messageId);
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
      const liveDeliveryTarget = routableBindings(proj).some((binding) =>
        binding.agent_id === hook.agent_id);
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
        const generation = await this.tmux.seatGeneration(sender.seat_id);
        const sent = generation !== sender.pane_generation
          ? { bytes: 0, verdict: 'seat_unresolved' as const }
          : await this.tmux.sendVerifiedToSeat(sender.seat_id, correlationId, renderedFrame, undefined, sender.engine ?? undefined, sender.pane_generation);
        await this.store.append({ entity_type: 'message', entity_id: correlationId, event_type: 'act.agent_input_injected',
          payload: {
            target_agent_id: sourceAgentId, seat_id: sender.seat_id, bytes: committedTransportBytes(sent),
            submit_verdict: sent.verdict, input_class: 'delivery_confirmation',
            message_ids: messageIds, rendered_frame: renderedFrame,
          }, provenance: this.prov('observer', receipt), occurred_at: this.now() });
        if (sent.verdict !== 'staged') throw new Error(`delivery_confirmation_not_staged:${sent.verdict}`);
      }
      return { ok: true, asserted, dead_lettered: [] };
    });
  }

  // Phase two, read back. The delivery fact for one message and every target it
  // was snapshotted against, derived from `act.comm_delivery_asserted` alone —
  // never from the bytes that were staged, which is the conflation this surface
  // exists to end.
  async commDelivery(messageId: string): Promise<CommDeliveryReadResponse> {
    const events = await this.events();
    const accepted = events.find((e) => e.entity_id === messageId && e.event_type === 'reg.comm_accepted');
    if (!accepted) throw new Error('message_absent');
    const snapshot = events.find((e) => e.event_type === 'reg.comm_target_snapshotted' && e.payload.message_id === messageId);
    const targets = (snapshot?.payload.targets ?? accepted.payload.targets ?? []) as CommTarget[];
    const deliveries = targets.map((target) => {
      const assertion = events.find((e) => e.event_type === 'act.comm_delivery_asserted'
        && e.payload.message_id === messageId && e.payload.target_agent_id === target.agent_id);
      // Read from `act.comm_delivery_failed` alone, exactly as `delivered`
      // reads from the assertion alone. A refusal is never inferred from an
      // assertion's absence — that absence is the silence this pair exists to
      // stop being the only answer.
      const failure = events.find((e) => e.event_type === 'act.comm_delivery_failed'
        && e.payload.message_id === messageId && e.payload.target_agent_id === target.agent_id);
      return {
        target, delivered: assertion !== undefined,
        asserted_at: assertion?.occurred_at ?? null,
        assertion_event_id: assertion?.seq ?? null,
        failed: assertion === undefined && failure !== undefined,
        failed_at: assertion === undefined ? failure?.occurred_at ?? null : null,
        failure_event_id: assertion === undefined ? failure?.seq ?? null : null,
        failure_reason: assertion === undefined ? (failure ? String(failure.payload.reason) : null) : null,
      };
    });
    return {
      schema_version: SCHEMA_VERSION, message_id: messageId,
      source_agent_id: String(accepted.payload.source_agent_id),
      accepted_at: accepted.occurred_at,
      deliveries, complete: deliveries.length > 0 && deliveries.every((d) => d.delivered),
      resolved: deliveries.length > 0 && deliveries.every((d) => d.delivered || d.failed),
    };
  }

  async waitCommReceipt(req: CommReceiptWaitRequest): Promise<CommReceipt> {
    if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
    const state = async () => {
      const events = await this.events();
      const accepted = events.find((event) => event.entity_id === req.message_id && event.event_type === 'reg.comm_accepted');
      if (!accepted) throw new Error('message_absent');
      if (accepted.payload.source_agent_id !== req.source_agent_id) throw new Error('comm_source_mismatch');
      const delivery = await this.commDelivery(req.message_id);
      const sentRows = events.filter((event) => event.entity_id === req.message_id && event.event_type === 'act.comm_bytes_sent');
      const sent = [...new Map(sentRows.map((event) => [String(event.payload.target_agent_id), event])).values()];
      const deadline = Math.max(...sent.map((event) => Date.parse(String(event.payload.receipt_deadline_at ?? ''))));
      const deadlineByTarget = new Map(sent.map((event) => [
        String(event.payload.target_agent_id),
        Date.parse(String(event.payload.receipt_deadline_at ?? '')),
      ]));
      const timely = delivery.complete && delivery.deliveries.every((row) => {
        const targetDeadline = deadlineByTarget.get(row.target.agent_id);
        const assertedAt = Date.parse(row.asserted_at ?? '');
        return targetDeadline !== undefined && Number.isFinite(assertedAt) && assertedAt < targetDeadline;
      });
      return { accepted, delivery, sent, deadline, timely };
    };

    let transportWake!: () => void;
    const transportEvent = new Promise<void>((resolve) => { transportWake = resolve; });
    const transportWaiters = this.commTransportWaiters.get(req.message_id) ?? new Set<() => void>();
    transportWaiters.add(transportWake);
    this.commTransportWaiters.set(req.message_id, transportWaiters);
    let wake!: () => void;
    const event = new Promise<void>((resolve) => { wake = resolve; });
    const waiters = this.deliveryWaiters.get(req.message_id) ?? new Set<() => void>();
    waiters.add(wake);
    this.deliveryWaiters.set(req.message_id, waiters);
    let cancel = () => {};
    try {
      let current = await state();
      const targets = (current.accepted.payload.targets ?? []) as CommTarget[];
      if (current.sent.length < targets.length
        && !this.commTransportsInFlight.has(req.message_id)) {
        await this.terminalizeInactiveCommTransport(req.message_id);
        current = await state();
      }
      // Admission is returned before pane I/O. Join the daemon's one transport
      // completion event instead of polling or inventing a timeout for an
      // operation with no truthful elapsed-time ceiling.
      if (current.sent.length < targets.length) {
        await transportEvent;
        current = await state();
      }
      if (current.sent.length < targets.length) throw new Error('comm_transport_receipt_incomplete');
      if (!Number.isFinite(current.deadline)) throw new Error('comm_receipt_deadline_absent');
      const unstaged = current.sent.filter((row) => row.payload.submit_verdict !== 'staged');
      if (current.sent.length === targets.length && unstaged.length > 0) {
        const verdicts = new Set(unstaged.map((row) => String(row.payload.submit_verdict)));
        return {
          ok: false, schema_version: SCHEMA_VERSION, phase: 'transport_refused',
          message_id: req.message_id, source_agent_id: req.source_agent_id,
          targets,
          bytes_sent: current.sent.reduce((sum, row) => sum + Number(row.payload.bytes ?? 0), 0),
          submit_verdict: verdicts.size === 1
            ? [...verdicts][0] as 'submit_failed' | 'transport_failed' | 'seat_unresolved'
            : 'multiple',
          refusals: unstaged.map((row) => ({
            target: targets.find((target) => target.agent_id === row.payload.target_agent_id)!,
            bytes: Number(row.payload.bytes ?? 0),
            submit_verdict: String(row.payload.submit_verdict) as 'submit_failed' | 'transport_failed' | 'seat_unresolved',
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
      // Transport landed and delivery then became impossible. The sender is
      // told so rather than handed `bytes_sent`, which would read as a message
      // still on its way to a composer that no longer exists.
      if (current.delivery.deliveries.some((row) => row.failed)) {
        return {
          ok: false, schema_version: SCHEMA_VERSION, phase: 'delivery_failed',
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
          row.payload.submit_verdict === 'staged'),
        event_ids: current.sent.map((row) => row.seq),
      };
    } finally {
      cancel();
      const transportCurrent = this.commTransportWaiters.get(req.message_id);
      transportCurrent?.delete(transportWake);
      if (transportCurrent?.size === 0) this.commTransportWaiters.delete(req.message_id);
      const current = this.deliveryWaiters.get(req.message_id);
      current?.delete(wake);
      if (current?.size === 0) this.deliveryWaiters.delete(req.message_id);
    }
  }

  commStop(agentId: string, content: string, stopEventId: string | null, receipt: string | null): Promise<void> {
    return this.locked(async () => {
      const events = await this.events();
      const askIds = new Set(events
        .filter((e) => e.event_type === 'reg.comm_accepted' && typeof e.payload.ask_id === 'string')
        .map((e) => String(e.payload.ask_id)));
      const asks = events.filter((e) => e.event_type === 'reg.comm_target_snapshotted'
        && askIds.has(e.entity_id)
        && (e.payload.targets as CommTarget[]).some((t) => t.agent_id === agentId));
      for (const ask of asks) await this.assertCallback(ask.entity_id, agentId, content, 'stop', stopEventId, receipt);
    });
  }

  async lifecycleCommEffect(
    req: LifecycleCommEffectRequest,
    transportReceipt: string | null = null,
  ): Promise<LifecycleCommEffectResponse> {
    const fenced = await this.locked(async () => {
      if (req.schema_version !== SCHEMA_VERSION) {
        throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
      }
      const projections = await this.projections();
      const source = routableBindings(projections).find((binding) =>
        binding.agent_id === req.source.agent_id
        && binding.seat_id === req.source.seat_id
        && binding.persona === req.source.persona
        && binding.birth_generation === req.source.birth_generation
        && binding.pane_generation === req.source.pane_generation);
      if (!source) throw new Error('source_effect_binding_mismatch');
      const target = routableBindings(projections).find((binding) =>
        binding.agent_id === req.target.agent_id
        && binding.seat_id === req.target.seat_id
        && binding.birth_generation === req.target.birth_generation
        && binding.pane_generation === req.target.pane_generation);
      if (!target) throw new Error('target_effect_binding_mismatch');
      return { sourceBoundSeq: source.bound_seq, targetBoundSeq: target.bound_seq };
    });

    const accepted = await this.comm({
      schema_version: req.schema_version,
      source_agent_id: req.source.agent_id,
      target: req.target.agent_id,
      message: req.message,
      ask: false,
      reply: false,
    }, transportReceipt, undefined, {
      messageId: req.effect_id,
      sourceAgentIdInFrame: req.source.agent_id,
      expectedSourceBoundSeq: fenced.sourceBoundSeq,
      expectedTargetAgentId: req.target.agent_id,
      expectedTargetBoundSeq: fenced.targetBoundSeq,
      lifecycleEffect: {
        effect_id: req.effect_id,
        source_birth_generation: req.source.birth_generation,
        source_pane_generation: req.source.pane_generation,
        target_birth_generation: req.target.birth_generation,
        target_pane_generation: req.target.pane_generation,
      },
    });
    return {
      ok: true,
      message_id: accepted.message_id,
      source_agent_id: accepted.source_agent_id,
      targets: accepted.targets,
      staged: accepted.staged,
      replayed: accepted.replayed === true,
      event_ids: accepted.event_ids,
    };
  }
  async waitComm(req: CommWaitRequest): Promise<CommWaitResponse> {
    if (req.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version_mismatch: daemon pins ${SCHEMA_VERSION}`);
    const read = async (): Promise<CommWaitResponse> => {
      const events = await this.events();
      const snapshot = events.find((e) => e.entity_id === req.ask_id && e.event_type === 'reg.comm_target_snapshotted');
      if (!snapshot) throw new Error('ask_absent');
      const targets = snapshot.payload.targets as CommTarget[];
      const accepted = events.find((e) => e.entity_id === snapshot.payload.message_id && e.event_type === 'reg.comm_accepted');
      if (accepted?.payload.source_agent_id !== req.subscriber_agent_id) throw new Error('ask_subscriber_mismatch');
      const callbacks: CommCallback[] = events.filter((e) =>
        e.event_type === 'act.comm_callback_asserted' && e.payload.ask_id === req.ask_id,
      ).map((e) => ({
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
      if (this.pendingScopedResetSeats().has(req.seat_id)) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `scoped_reset_pending: ${req.seat_id}`,
        };
      }
      if (proj.abandonedSeats.has(req.seat_id)) {
        return {
          ok: false,
          seat_id: req.seat_id,
          handover: false,
          missing_attestations: [],
          reason: `seat_abandoned: ${req.seat_id}`,
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

      await this.reconcileDeadStackSeatsUnlocked(null);

      await this.recoverScopedResets();

      // RULING (Emperor, 2026-08-25): restarts are not the sensitive operation;
      // closing panes is. A txd restart arrives with sweeping expectation
      // changes as often as every fleet merge — any merge in txd's workspace
      // closure restarts this daemon — so aggressive reconciliation at THIS
      // site risks dumping large swaths of the fleet to correct a one-row
      // layout error. Boot therefore observes and attests: a page that still
      // holds a live tagged pane is never rebuilt here, however far it has
      // drifted. Its divergence is flagged as a contradiction below, named
      // page-by-page on /health, and repaired only by an explicit operator
      // verb that computes the page's foreground workloads and refuses when
      // they are non-empty. A dead or missing seat is still repaired alone, in
      // place, exactly as the runtime lifecycle ingress repairs it; a page
      // with no live tagged pane left is the one class that is rebuilt.
      // Construction is all-or-nothing below the membrane: create on an empty
      // socket, accept the exact canonical shape, refuse every other estate.
      const estate = await this.tmux.ensureEstate();
      // Estate convergence can itself fire or replace tmux hooks while pages
      // are being rebuilt. The early install inside ensureEstate protects the
      // reconstruction; this final install + physical read-back is the boot
      // postcondition the health surface later observes.
      await this.tmux.ensureLifecycleHooks();
      // A repaired page contains entirely new terminal processes, even when tmux
      // reused one pane object as the reconstruction seed. Resolve every binding
      // in that border into event truth before the fresh bare seats are exposed.
      const rebuiltPages = new Set(estate.rebuilt_pages);
      const bindings = (await this.projections()).currentBindings.filter((binding) => {
        const page = binding.seat_id.split(':', 1)[0];
        return page !== undefined && isTxdPage(page) && rebuiltPages.has(page);
      });
      const bootRetiredAt = this.now();
      const bootEvents = await this.events();
      const bootRetirements = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, null, bootRetiredAt, bootEvents),
      );
      if (bootRetirements.length > 0) {
        await this.store.appendAll(bootRetirements);
        this.wakeCommDeliveryFailures(bootRetirements);
        await this.publishRetirements(bindings, 'estate_reset', bootRetiredAt);
      }
      // Pane-scoped repair of seats that died while txd was down: each faulted
      // seat retires alone and is respawned in place; siblings are untouched.
      const repaired = await this.repairFaultedSeatsUnlocked(
        Object.keys(TXD_WINDOWS) as TxdPage[], null, 'boot',
      );
      if (!repaired.ok && repaired.reason !== 'estate_already_canonical') {
        console.error(JSON.stringify({ level: 'error', event: 'boot_seat_repair_incomplete', reason: repaired.reason, reset_seats: repaired.reset_seats }));
      }
      await this.attestEstateDivergenceUnlocked(null);
      // Seats that already carry a `reg.pane_created` fact. A prior boot could
      // have torn (createSeat committed, its append did not) — the pane persists
      // but the fact was lost. Presence WITHOUT attestation is that torn state.
      const attested = new Set(
        (await this.events()).filter((e) => e.event_type === 'reg.pane_created').map((e) => e.entity_id),
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
    await this.assertOccupancyCensus();
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
      const source = routableBindings(proj).find((binding) =>
        binding.agent_id === req.source_agent_id);
      if (!source) return refused('source_not_registered: source_agent_id resolves to no registered binding');
      if (source.rank !== CLOSE_REQUIRED_RANK) {
        return refused(`not_authorized: close requires rank ${CLOSE_REQUIRED_RANK}; source ${req.source_agent_id} holds rank ${source.rank ?? 'none'}`);
      }

      const verdicts: CloseVerdict[] = [];
      const closeOne = async (target: string, binding: CurrentBinding): Promise<void> => {
        // Reap FIRST; attest only on a confirmed kill. executeClose is the one
        // close mechanism for bound seats: abortRegistration (which passes
        // signalUnregistered=false) and the bound-seat branch of dead-stack-seat
        // reconciliation take this same path; an unbound dead stack seat is
        // killed and abandoned without it.
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

      // Pane kills in a bulk retirement can rewrite tmux's global hook state.
      // Make physical read-back part of the running-daemon convergence just as
      // boot does, after the last close has had a chance to clobber it.
      await this.tmux.ensureLifecycleHooks();
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
  // bus refusal never un-closes the seat; a payload the contract refuses (a
  // non-registration launch identity) is skipped for the same reason. Both are
  // insurance gaps, not close failures — and both leave `recordDroppedPublication`
  // behind, because the gap that cost a consumer a leaked seat was not the
  // refusal, it was the silence after it.
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
        await this.recordDroppedPublication(
          'agent.retired',
          { entity_type: 'agent', entity_id: binding.agent_id, seat_id: binding.seat_id },
          'contract_refused',
          retirement.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(','),
        );
        continue;
      }
      try {
        await this.physicalRegistration.publish('agent.retired', retirement.data);
      } catch (error) {
        await this.recordDroppedPublication(
          'agent.retired',
          { entity_type: 'agent', entity_id: binding.agent_id, seat_id: binding.seat_id },
          'transport_refused',
          String(error),
        );
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
      await this.recordDroppedPublication(
        'agent.unregistered_closed',
        { entity_type: 'agent', entity_id: binding.agent_id!, seat_id: binding.seat_id },
        'contract_refused',
        signal.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(','),
      );
      return;
    }
    try {
      await this.physicalRegistration.publish('agent.unregistered_closed', signal.data);
    } catch (error) {
      await this.recordDroppedPublication(
        'agent.unregistered_closed',
        { entity_type: 'agent', entity_id: binding.agent_id!, seat_id: binding.seat_id },
        'transport_refused',
        String(error),
      );
    }
  }

  // A fact txd owed the journal and could not put there. Nothing is retried
  // here: the retry is the next boot's census, which asserts present truth
  // rather than replaying a stale one, and a timer over a refused bus would be
  // a number derived from nothing. What this adds is the trace — a dropped
  // publication that leaves no evidence is indistinguishable from a fact that
  // was never owed, which is precisely how a consumer came to hold a seat for
  // an agent that left it and never learned otherwise.
  private async recordDroppedPublication(
    publishedEventType: TxdPublishedEventType,
    // The thing the lost fact was about: the agent whose close it announced, or
    // the estate whose census it was.
    subject: { entity_type: 'agent' | 'estate'; entity_id: string; seat_id: string | null },
    reason: 'contract_refused' | 'transport_refused',
    detail: string,
  ): Promise<void> {
    console.error(JSON.stringify({
      level: 'error',
      event: 'journal_publication_dropped',
      published_event_type: publishedEventType,
      entity_id: subject.entity_id,
      seat_id: subject.seat_id,
      reason,
      detail,
    }));
    await this.store.append({
      entity_type: subject.entity_type,
      entity_id: subject.entity_id,
      event_type: 'reg.journal_publication_dropped',
      payload: {
        published_event_type: publishedEventType,
        seat_id: subject.seat_id,
        reason,
        detail,
      },
      provenance: this.prov('observer', null),
      occurred_at: this.now(),
    });
  }

  // The generic close mechanism for a bound seat, shared by POST /agents/close,
  // abortRegistration (signalUnregistered=false), and the bound-seat branch of
  // reconcileDeadStackSeatsUnlocked.
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
      inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_abandoned', payload: {}, provenance: prov, occurred_at });
    }
    inputs.push(...this.commDeliveryFailures(
      await this.events(), binding.agent_id, 'delivery_target_closed', occurred_at, prov,
    ));
    await this.store.appendAll(inputs);
    this.wakeCommDeliveryFailures(inputs);
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
      const stopEvent = await this.store.append({
        entity_type: 'agent',
        entity_id: req.agent_id,
        event_type: 'act.stop_reported',
        payload: {},
        provenance: this.prov('hook', transportReceipt),
        occurred_at: this.now(),
      });

      // The turn-stop delivery join. A mid-turn comm frame produces NO
      // UserPromptSubmit — the engine queues it into the running turn (live
      // specimens 994854e0, b9c1ca52, 2a243960) — so the hook join above can
      // never speak for it. The full evidence chain substitutes: the frame was
      // staged into an engine observed WORKING at send (target_turn), this
      // fresh stop attests that turn completed, and one composer-at-rest
      // capture proves the exact frame no longer sits in the visible composer
      // — it left it into the queue the finished turn consumed. The capture
      // happens HERE, at the stop, because the engine is at rest: a capture at
      // send time races the busy engine's repaint and proves nothing
      // (specimen e5757301). Any partial chain stays undelivered — a frame an
      // interrupted turn left painted refuses as frame_present, an invisible
      // composer refuses as unobservable, and a later fresh stop retries with
      // fresh evidence. A deduped or refused stop never reaches this join.
      const events = await this.events();
      for (const receipt of events) {
        if (receipt.event_type !== 'act.comm_bytes_sent'
          || receipt.payload.target_agent_id !== req.agent_id
          || receipt.payload.submit_verdict !== 'staged'
          || receipt.payload.target_turn !== 'working') continue;
        const messageId = receipt.entity_id;
        const accepted = events.find((event) => event.entity_id === messageId && event.event_type === 'reg.comm_accepted');
        if (!accepted) continue;
        const snapshot = events.find((event) => event.event_type === 'reg.comm_target_snapshotted'
          && event.payload.message_id === messageId);
        const snapshotTargets = (snapshot?.payload.targets ?? []) as CommTarget[];
        if (!snapshotTargets.some((target) => target.agent_id === req.agent_id)) continue;
        const assertionId = `${messageId}:${req.agent_id}`;
        if (events.some((event) => event.entity_id === assertionId && event.event_type === 'act.comm_delivery_asserted')) continue;
        const observation = await this.tmux.observeFrameAbsence(
          String(receipt.payload.seat_id),
          String(receipt.payload.rendered_frame),
        );
        if (observation !== 'frame_absent') continue;
        await this.store.append({
          entity_type: 'assertion', entity_id: assertionId, event_type: 'act.comm_delivery_asserted',
          payload: {
            message_id: messageId,
            target_agent_id: req.agent_id,
            source_agent_id: accepted.payload.source_agent_id,
            attestation: 'turn_stop',
            stop_event_seq: stopEvent.seq,
            transport_receipt_seq: receipt.seq,
            frame_observation: observation,
          },
          provenance: this.prov('hook', transportReceipt), occurred_at: this.now(),
        });
        this.wakeDelivery(messageId);
      }

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
      await this.attestEstateDivergenceUnlocked(transportReceipt);
      const events = await this.events();
      const t0 = performance.now();
      const proj = await this.projections();
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
      // all. `paneBySeat` is only ever removed from by reg.seat_abandoned —
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
          'seat_abandoned',
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
      const openContradictions = (await this.projections()).openContradictions;
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
      const source = routableBindings(proj).find((binding) =>
        binding.agent_id === req.source_agent_id);
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
          && candidate.missing_attestation === 'seat_abandoned');
        if (!contradiction) return refused(`seat_not_flagged_absent: ${seat}`);
      }
      const occurred_at = this.now();
      const provenance = this.prov('wrapper', transportReceipt);
      await this.store.appendAll(req.seats.map((seat) => ({
        entity_type: 'seat' as const,
        entity_id: seat,
        event_type: 'reg.seat_abandoned',
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

  compactEventLog(request: EventLogCompactionRequest): Promise<EventLogCompactionResult> {
    return this.locked(async () => {
      if (request.schema_version !== SCHEMA_VERSION) throw new Error('schema_version_mismatch');
      const result = await this.store.compact(request);
      await this.rebuildProjection();
      return result;
    });
  }

  async tintReadiness(): Promise<TintReadiness[]> {
    const proj = await this.projections();
    const observedSeats = await this.tmux.seatReadiness();
    const paneBySeat = new Map(observedSeats.map((seat) => [seat.seat_id, seat.pane]));
    const readinessBySeat = new Map(observedSeats.map((seat) => [seat.seat_id, seat]));
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
      const physical = readinessBySeat.get(seat_id);
      const observed = physical?.tint;
      const generationReady = !binding
        || physical?.generation === binding.pane_generation;
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

  /**
   * Assert who is seated. The sweep above says which declared seats the estate
   * wants filled; this says who is actually in them, and it is the same kind of
   * statement: txd owns where an agent sits, so it says so, and consumers fold
   * it like any other journal fact.
   *
   * The assertion is COMPLETE over this machine — these and only these agents
   * are seated on it — because completeness is the only thing that reaches an
   * agent nobody will ever publish another event about. `agent.retired` is
   * published after the close is already committed and a refusal is never
   * revisited; a consumer that missed one is not waiting for anything. Neither
   * is a seat-keyed reconciliation enough: a seat from an estate generation
   * this machine no longer declares can never be reassigned, so nothing will
   * ever displace the agent recorded in it. A roster of the living can.
   *
   * It is taken once, at boot fold completion, from binding truth just folded.
   * Not a timer, not a repeating sweep: the estate changes at close, launch,
   * and reset, and each of those already publishes its own fact. This is the
   * assertion of present truth that lets a consumer that missed one recover.
   *
   * A payload the contract refuses publishes NOTHING. A roster missing an
   * occupant it could not represent, asserted as complete, would tell a
   * consumer to release a live agent — the leak pointed the other way, and
   * silent. Fail dark and leave the trace.
   */
  async assertOccupancyCensus(): Promise<void> {
    if (!this.physicalRegistration) return;
    return this.locked(async () => {
      const machine = this.physicalRegistration!.machine;
      const takenAt = this.now();
      const occupied = (await this.projections()).currentBindings
        .filter((binding) => binding.agent_id !== null)
        .map((binding) => ({
          seat_id: binding.seat_id,
          agent_id: binding.agent_id,
          birth_generation: binding.birth_generation,
          pane_generation: binding.pane_generation,
          registered: binding.registered,
        }))
        .sort((left, right) => left.seat_id.localeCompare(right.seat_id));
      const census = EstateOccupancyCensusSchema.safeParse({
        schema_version: AGENT_SCHEMA_VERSION,
        machine,
        configuration: this.physicalRegistration!.configuration,
        occupied,
        taken_at: takenAt,
      });
      const subject = { entity_type: 'estate' as const, entity_id: machine, seat_id: null };
      if (!census.success) {
        await this.recordDroppedPublication(
          'agent.estate_occupancy_census',
          subject,
          'contract_refused',
          census.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(','),
        );
        return;
      }
      try {
        await this.physicalRegistration!.publish('agent.estate_occupancy_census', census.data);
      } catch (error) {
        await this.recordDroppedPublication(
          'agent.estate_occupancy_census',
          subject,
          'transport_refused',
          String(error),
        );
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
    trigger: 'operator' | 'pane-died' | 'pane-exited' | 'pane-killed' | 'boot' = 'operator',
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
      const resetEvents = await this.events();
      const inputs = bindings.flatMap((binding) =>
        this.resetBindingInputs(binding, transportReceipt, completedAt, resetEvents),
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
      this.wakeCommDeliveryFailures(inputs);
      await this.publishRetirements(bindings, 'estate_reset', completedAt);
    return { ok: true, rotation_id, accepted: true, force: req.force, scope, seats, bound_seats, foreground_workloads, reason: null };
  }

  /**
   * Every canonical page failing the acceptance predicate becomes one open
   * contradiction on the page entity; a page observed canonical again closes
   * its contradiction with a later fact on the same entity. Observation only:
   * this never touches tmux.
   */
  private async attestEstateDivergenceUnlocked(transportReceipt: string | null): Promise<void> {
    const divergences = await this.tmux.estateDivergences();
    const open = new Map((await this.projections()).openContradictions
      .filter((contradiction) => contradiction.entity_type === 'estate' && contradiction.kind === 'page_drift')
      .map((contradiction) => [contradiction.entity_id, contradiction]));
    for (const divergence of divergences) {
      const detail = `${divergence.clause}: ${divergence.detail}`;
      if (open.get(divergence.page)?.detail === detail) continue;
      await this.store.append({
        entity_type: 'estate',
        entity_id: divergence.page,
        event_type: 'reg.contradiction_flagged',
        payload: { kind: 'page_drift', missing_attestation: null, detail, clause: divergence.clause },
        provenance: this.prov('observer', transportReceipt),
        occurred_at: this.now(),
      });
      console.error(JSON.stringify({ level: 'error', event: 'contradiction_flagged', p0: true, entity_id: divergence.page, kind: 'page_drift', detail }));
    }
    for (const page of open.keys()) {
      if (divergences.some((divergence) => divergence.page === page)) continue;
      await this.store.append({
        entity_type: 'estate',
        entity_id: page,
        event_type: 'estate.page_canonical_observed',
        payload: { page },
        provenance: this.prov('observer', transportReceipt),
        occurred_at: this.now(),
      });
    }
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
      const repaired = await this.repairFaultedSeatsUnlocked(pages, transportReceipt, req.event);
      return { ...repaired, event: req.event, page };
    });
    if (result.ok && result.reconstructed) await this.announceVacantPerpetualSeats();
    return result;
  }

  /**
   * Repair every dead or missing seat on `pages` in place. Fault scope is the
   * pane: the faulted seat retires loudly and alone while its siblings, which
   * carry no fault, are never touched. Only a page with no tagged pane left
   * has nothing to anchor a repair to; that class alone earns the page
   * rebuild, and by then there is nobody left on the page to sacrifice.
   */
  private async repairFaultedSeatsUnlocked(
    pages: TxdPage[],
    transportReceipt: string | null,
    trigger: 'pane-died' | 'pane-exited' | 'pane-killed' | 'boot',
  ): Promise<Omit<TmuxLifecycleEventResponse, 'event' | 'page'>> {
      const observed = await this.tmux.listSeats();
      const reset_seats: string[] = [];
      const rotation_ids: string[] = [];
      let ok = true;
      let reconstructed = false;
      let reason: string | null = null;
      let faultedPages = 0;
      const retiredStackSeats = await this.reconcileDeadStackSeatsUnlocked(transportReceipt, new Set(pages));
      if (retiredStackSeats.length > 0) {
        reset_seats.push(...retiredStackSeats);
        reconstructed = true;
        faultedPages += new Set(retiredStackSeats.map((seat) => seat.split(':', 1)[0])).size;
      }
      for (const target of pages) {
        const expected = [...TXD_WINDOWS[target]];
        const pageObserved = observed.filter((seat) => seat.seat_id.startsWith(`${target}:`));
        const dead = new Set(expected.filter((seat) => pageObserved.some((o) => o.seat_id === seat && o.pane === 'dead')));
        const missing = new Set(expected.filter((seat) => !pageObserved.some((o) => o.seat_id === seat)));
        const faulted = expected.filter((seat) => dead.has(seat) || missing.has(seat));
        if (faulted.length === 0) continue;
        faultedPages += 1;
        // A dead pane is one faulted PROCESS whose remain-on-exit corpse is
        // the respawn target; a missing pane is one killed TERMINAL whose
        // surviving siblings anchor an in-place repair.
        if (pageObserved.length === 0) {
          const reset = await this.resetEstateScopeUnlocked(
            { schema_version: SCHEMA_VERSION, force: true, scope: 'page', page: target },
            transportReceipt,
            trigger,
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
            trigger,
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
          ok: true, reconstructed: false, reset_seats: [], rotation_ids: [],
          reason: pages.length > 1 ? 'estate_already_canonical' : 'page_already_canonical',
        };
      }
      return { ok, reconstructed, reset_seats, rotation_ids, reason };
  }

  /**
   * The refusal every staged-but-unattested comm to this agent is owed, written
   * in the same transaction that ends the agent's binding. The binding ending
   * IS the moment delivery became impossible — the composer holding those bytes
   * is gone — so this is an observed effect, not a deadline expiring and not an
   * inference from a missing assertion.
   *
   * Without it a dropped comm and a pending one read identically forever:
   * `delivered: false` with nothing else to distinguish them. The sibling of
   * `abortPaneRuns`, which fails a reset seat's staged shell runs loud for the
   * same reason.
   */
  private commDeliveryFailures(
    events: EventRecord[],
    agentId: string | null,
    reason: 'delivery_target_closed' | 'delivery_target_reset',
    occurred_at: string,
    prov: EventInput['provenance'],
  ): EventInput[] {
    if (!agentId) return [];
    const inputs: EventInput[] = [];
    for (const receipt of events) {
      if (receipt.event_type !== 'act.comm_bytes_sent'
        || receipt.payload.target_agent_id !== agentId
        || receipt.payload.submit_verdict !== 'staged') continue;
      const messageId = receipt.entity_id;
      const assertionId = `${messageId}:${agentId}`;
      if (events.some((event) => event.entity_id === assertionId
        && event.event_type === 'act.comm_delivery_asserted')) continue;
      const failureId = `comm-delivery-failure:${messageId}:${agentId}`;
      if (events.some((event) => event.entity_id === failureId
        && event.event_type === 'act.comm_delivery_failed')) continue;
      if (inputs.some((input) => input.entity_id === failureId)) continue;
      const accepted = events.find((event) => event.entity_id === messageId
        && event.event_type === 'reg.comm_accepted');
      if (!accepted) continue;
      inputs.push({
        entity_type: 'assertion', entity_id: failureId, event_type: 'act.comm_delivery_failed',
        payload: {
          message_id: messageId,
          target_agent_id: agentId,
          source_agent_id: accepted.payload.source_agent_id,
          seat_id: receipt.payload.seat_id,
          transport_receipt_seq: receipt.seq,
          reason,
        },
        provenance: prov, occurred_at,
      });
    }
    return inputs;
  }

  private resetBindingInputs(
    binding: CurrentBinding,
    transportReceipt: string | null,
    occurred_at: string,
    events: EventRecord[],
  ): EventInput[] {
    const prov = this.prov('observer', transportReceipt);
    const inputs: EventInput[] = [];
    if (binding.agent_id) inputs.push({ entity_type: 'agent', entity_id: binding.agent_id, event_type: 'reg.retired', payload: {}, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.process_reaped', payload: { agent_id: binding.agent_id }, provenance: prov, occurred_at });
    inputs.push({ entity_type: 'seat', entity_id: binding.seat_id, event_type: 'reg.seat_cleared', payload: {}, provenance: prov, occurred_at });
    inputs.push(...this.commDeliveryFailures(events, binding.agent_id, 'delivery_target_reset', occurred_at, prov));
    return inputs;
  }

  private async reconcileDeadStackSeatsUnlocked(
    transportReceipt: string | null,
    pages: ReadonlySet<TxdPage> | null = null,
  ): Promise<string[]> {
    const observed = await this.tmux.listSeats();
    const paneBySeat = new Map(observed.map((seat) => [seat.seat_id, seat.pane]));
    const proj = await this.projections();
    const candidates = new Set<string>();
    for (const seat of observed) {
      const page = seat.seat_id.split(':', 1)[0] as TxdPage;
      if (seat.pane === 'dead' && isStackSeat(seat.seat_id) && !TXD_ESTATE.includes(seat.seat_id)
        && (pages === null || pages.has(page))) candidates.add(seat.seat_id);
    }
    for (const binding of proj.currentBindings) {
      const page = binding.seat_id.split(':', 1)[0] as TxdPage;
      if (isStackSeat(binding.seat_id) && !TXD_ESTATE.includes(binding.seat_id)
        && paneBySeat.get(binding.seat_id) !== 'live' && (pages === null || pages.has(page))) {
        candidates.add(binding.seat_id);
      }
    }
    const retired: string[] = [];
    for (const seat of candidates) {
      const binding = proj.currentBindings.find((candidate) => candidate.seat_id === seat);
      if (binding) {
        if (!(await this.executeClose(binding, transportReceipt))) continue;
      } else {
        await this.tmux.killSeat(seat);
        if ((await this.tmux.listSeats()).some((row) => row.seat_id === seat)) {
          throw new Error(`txd could not verify dynamic stack seat cleanup for ${seat}`);
        }
        await this.store.append({
          entity_type: 'seat', entity_id: seat, event_type: 'reg.seat_abandoned', payload: {},
          provenance: this.prov('observer', transportReceipt), occurred_at: this.now(),
        });
      }
      retired.push(seat);
    }
    return retired;
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
      const events = await this.events();
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

}

export type { EventInput };
