// txd lifecycle vocabulary (`@terminus-os/contracts`).
//
// The single shared lifecycle vocabulary for txd, the tmuxctld-successor
// estate daemon, ruled in [[k12-daemon-spec]] §2–§7 and re-homed here by the
// [[txd-extraction-spec]] (§3.2: contracts re-home — no shims, no compat
// layer). The daemon speaks this natively; the cockpit wins by convergence.
//
// Design invariants baked into these types (spec §3):
//   - ONE stream, typed domains within it (`reg.*` / `act.*`) — the domain is a
//     prefix on `event_type`, NOT a second store. reg.* = registration/binding
//     lifecycle + daemon observations; act.* = agent behavior + send activity.
//   - The event vocabulary is CLOSED — no additions or removals without a
//     `schema_version` bump.
//   - The single `status` field is DEAD. Orthogonal axes only.
//   - `schema_version` is a single integer; the daemon pins it exactly.
//
// This is a TS-source package: consumers compile it directly, no build step.

import { z } from 'zod';

// The daemon pins this exact integer. Additive vocabulary = minor bump (cockpit
// conforms lazily); breaking changes land daemon+cockpit in ONE PR. Old events
// replay under the vocabulary that wrote them via `provenance.emitter_version`.
//
// v6: additive — explicit estate rotation request/refusal/completion lifecycle.
// v7: additive — Council topology migration and canonical seat decommissioning.
// v8: physical persona-tint apply/read-back, fail-dark reset, and readiness.
// v9: typed, engine-aware plan-mode transition request/attestation lifecycle.
// v10: registrationd-owned identity and generation-bound physical facts.
// v11: breaking — lifecycle correlation moves to lifecycled; the txd-internal
//      close-on-stop subscription vocabulary is gone, and plan approval gains
//      its mechanical intent (approve_plan, dialog_accept).
export const SCHEMA_VERSION = 11;

export const CLIPBOARD_BUFFER_NAME = 'tx-clipboard';
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_CLIPBOARD_BASE64_CHARS = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4;

function validClipboardText(value: string): boolean {
  return value.isWellFormed()
    && new TextEncoder().encode(value).length <= MAX_CLIPBOARD_BYTES;
}

export const ClipboardPullRequestSchema = z.object({
  schema_version: z.number().int(),
  content: z.string().refine(validClipboardText, 'clipboard must be valid UTF-8 at most 1 MiB'),
});
export type ClipboardPullRequest = z.infer<typeof ClipboardPullRequestSchema>;

export const ClipboardPushRequestSchema = z.object({
  schema_version: z.number().int(),
  buffer_name: z.literal(CLIPBOARD_BUFFER_NAME),
});
export type ClipboardPushRequest = z.infer<typeof ClipboardPushRequestSchema>;

export const ClipboardSelectionRequestSchema = z.object({
  schema_version: z.number().int(),
  client_tty: z.string().regex(/^\/dev\/(?:pts\/[0-9]+|tty[A-Za-z0-9._-]*)$/),
  content: z.string().refine(validClipboardText, 'clipboard must be valid UTF-8 at most 1 MiB'),
});
export type ClipboardSelectionRequest = z.infer<typeof ClipboardSelectionRequestSchema>;

export const ClipboardPullResponseSchema = z.object({
  ok: z.literal(true),
  target: z.string().min(1),
  buffer_name: z.literal(CLIPBOARD_BUFFER_NAME),
  bytes: z.number().int().nonnegative().max(MAX_CLIPBOARD_BYTES),
});
export type ClipboardPullResponse = z.infer<typeof ClipboardPullResponseSchema>;

export const ClipboardSelectionResponseSchema = ClipboardPullResponseSchema;
export type ClipboardSelectionResponse = z.infer<typeof ClipboardSelectionResponseSchema>;

export const ClipboardPushResponseSchema = ClipboardPullResponseSchema.extend({
  content_base64: z.string()
    .max(MAX_CLIPBOARD_BASE64_CHARS)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'invalid base64'),
});
export type ClipboardPushResponse = z.infer<typeof ClipboardPushResponseSchema>;

// ── Entities ────────────────────────────────────────────────────────────────
// The entity kinds the daemon tracks.
export const ENTITY_TYPES = ['seat', 'wrapper', 'agent', 'message', 'ask', 'assertion', 'estate'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const EntityTypeSchema = z.enum(ENTITY_TYPES);

// ── Event vocabulary — domain-partitioned typed lifecycle facts (spec §3) ────
// Domain is encoded as a prefix on the qualified event_type. There is ONE
// stream; the prefix enables per-domain projections/retention later without a
// parallel behavior stream (rejected explicitly as a split-brain factory).
export const EVENT_DOMAINS = ['reg', 'act', 'estate'] as const;
export type EventDomain = (typeof EVENT_DOMAINS)[number];

// reg.* — registration & binding lifecycle, plus daemon observations about it.
export const REG_EVENT_NAMES = [
  'dispatch_requested',
  'launch_composed', // identity + nonce (+ ssh target) set on the pane environment at dispatch
  'transport_claimed', // the wrapper's placement claim, recorded for the Door-1 audit
  'pane_created',
  'wrapper_started',
  'physical_declared',
  'placement_attested',
  'agent_registered',
  'binding_prepared',
  'binding_aborted',
  'bound',
  'comm_accepted',
  'comm_target_snapshotted',
  'contradiction_flagged',
  'teardown_started',
  'process_reaped',
  'retired',
  'seat_cleared',
  'seat_decommissioned',
] as const;

// act.* — agent behavior (feeds the `activity` axis) + comm activity.
export const ACT_EVENT_NAMES = [
  'prompt_submitted',
  'stop_reported',
  'receipt_deduped',
  'comm_bytes_sent',
  'comm_delivery_asserted',
  'comm_callback_asserted',
  'mode_transition_requested',
  'mode_transition_attested',
  'mode_transition_failed',
] as const;
export const ESTATE_EVENT_NAMES = [
  'rotation_refused',
  'rotation_requested',
  'rotation_completed',
  'scoped_reset_refused',
  'scoped_reset_requested',
  'scoped_reset_completed',
  'scoped_reset_failed',
  'topology_migration_requested',
  'topology_migration_completed',
] as const;

// The qualified event_type union (`<domain>.<name>`), enumerated literally so
// the type stays a narrow literal union and stays greppable.
export const EVENT_TYPES = [
  'reg.dispatch_requested',
  'reg.launch_composed',
  'reg.transport_claimed',
  'reg.pane_created',
  'reg.wrapper_started',
  'reg.physical_declared',
  'reg.placement_attested',
  'reg.agent_registered',
  'reg.binding_prepared',
  'reg.binding_aborted',
  'reg.bound',
  'reg.comm_accepted',
  'reg.comm_target_snapshotted',
  'reg.contradiction_flagged',
  'reg.teardown_started',
  'reg.process_reaped',
  'reg.retired',
  'reg.seat_cleared',
  'reg.seat_decommissioned',
  'act.prompt_submitted',
  'act.stop_reported',
  'act.receipt_deduped',
  'act.comm_bytes_sent',
  'act.comm_delivery_asserted',
  'act.comm_callback_asserted',
  'act.mode_transition_requested',
  'act.mode_transition_attested',
  'act.mode_transition_failed',
  'estate.rotation_refused',
  'estate.rotation_requested',
  'estate.rotation_completed',
  'estate.scoped_reset_refused',
  'estate.scoped_reset_requested',
  'estate.scoped_reset_completed',
  'estate.scoped_reset_failed',
  'estate.topology_migration_requested',
  'estate.topology_migration_completed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EventTypeSchema = z.enum(EVENT_TYPES);

export function eventDomain(eventType: EventType): EventDomain {
  return eventType.slice(0, eventType.indexOf('.')) as EventDomain;
}

// ── Orthogonal axes (spec §3) — the single status field is dead ──────────────
export const PANE_STATES = ['live', 'dead', 'empty'] as const;
export type PaneState = (typeof PANE_STATES)[number];
export const PaneStateSchema = z.enum(PANE_STATES);

export const BINDING_STATES = ['unbound', 'bound'] as const;
export type BindingState = (typeof BINDING_STATES)[number];
export const BindingStateSchema = z.enum(BINDING_STATES);

export const ACTIVITY_STATES = ['working', 'idle', 'stopped', 'retired'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];
export const ActivityStateSchema = z.enum(ACTIVITY_STATES);

// ── Provenance (spec §2) — three real emitters, hooks REAL but UNTRUSTED ──────
export const PROVENANCE_SOURCES = ['hook', 'wrapper', 'observer'] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];
export const ProvenanceSchema = z.object({
  source: z.enum(PROVENANCE_SOURCES),
  // The localhost edge_proxy transport receipt — separates hook-never-fired
  // from swallowed-after-arrival. Null when the emitter is the daemon itself.
  transport_receipt: z.string().nullable().optional(),
  emitter_version: z.number().int().nullable().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── Event record (spec §2) — the 8 append-only columns, nothing derived ──────
// Payload holds DUMB FACTS only, never derived state. The store assigns `seq`
// (global monotonic, single writer) and `recorded_at` (daemon clock; skew vs
// `occurred_at` is visible data).
export const EventInputSchema = z.object({
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  event_type: EventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  occurred_at: z.string().min(1),
});
export type EventInput = z.infer<typeof EventInputSchema>;

export const EventRecordSchema = EventInputSchema.extend({
  seq: z.number().int(),
  recorded_at: z.string(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

// ── Projections (spec §10) — all three rebuilt by replay, nobody writes them ─
export const CurrentBindingSchema = z.object({
  seat_id: z.string(),
  agent_id: z.string().nullable(),
  birth_generation: z.string().nullable(),
  registered: z.boolean(),
  persona: z.string().nullable(),
  rank: z.string().nullable(),
  commander: z.string().nullable(),
  tint: z.string().nullable(),
  pane_generation: z.string().nullable(),
  engine: z.enum(['claude', 'codex']).nullable(),
  wrapper_pid: z.number().int().positive().nullable(),
  configuration_generation: z.string().nullable(),
  configuration_digest: z.string().nullable(),
  // The bound-event seq the binding resolved against — receipts and drains
  // resolve against this exact seq (stale-target-at-drain unrepresentable).
  bound_seq: z.number().int(),
});
export type CurrentBinding = z.infer<typeof CurrentBindingSchema>;

export const FreelistEntrySchema = z.object({
  seat_id: z.string(),
  pane_state: PaneStateSchema, // live | empty (never dead — dead is a contradiction if bound)
});
export type FreelistEntry = z.infer<typeof FreelistEntrySchema>;

export const ActivityBoardRowSchema = z.object({
  entity_id: z.string(),
  entity_type: EntityTypeSchema,
  seat_id: z.string().nullable(),
  pane: PaneStateSchema,
  binding: BindingStateSchema,
  activity: ActivityStateSchema,
  persona: z.string().nullable(),
  rank: z.string().nullable(),
  commander: z.string().nullable(),
  tint: z.string().nullable(),
});
export type ActivityBoardRow = z.infer<typeof ActivityBoardRowSchema>;

// "Currently contradicted" is a STREAM FILTER, never a projection table.
export const OpenContradictionSchema = z.object({
  seq: z.number().int(),
  entity_type: EntityTypeSchema,
  entity_id: z.string(),
  kind: z.string(),
  missing_attestation: z.string().nullable(),
  detail: z.string().nullable(),
  occurred_at: z.string(),
});
export type OpenContradiction = z.infer<typeof OpenContradictionSchema>;

// ── API surface (spec §7) ────────────────────────────────────────────────────
export const TintReadinessSchema = z.object({
  seat_id: z.string(),
  binding: BindingStateSchema,
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  state: z.enum(['ready', 'missing', 'mismatched']),
});
export type TintReadiness = z.infer<typeof TintReadinessSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  service: z.literal('txd'),
  schema_version: z.number().int(),
  version: z.string(),
  git_sha: z.string(),
  bun: z.string(),
  machine: z.string(),
  events: z.number().int(),
  // Honest-only: bring-up mode reports ok=false while any contradiction is open.
  open_contradictions: z.number().int(),
  tmux_reachable: z.boolean(),
  tints: z.array(TintReadinessSchema),
});
export type Health = z.infer<typeof HealthSchema>;

export const LaunchRequestSchema = z.object({
  seat_id: z.string().min(1),
  schema_version: z.number().int(),
  // The attestation tuple the reg-audit scaffold checks. At door step 1 the
  // set is small; later doors grow it. A missing field the audit demands =
  // refused handover (stop-the-line), never a silent partial launch.
  identity: z.string().min(1).optional(),
  persona: z.string().min(1).optional(),
  rank: z.string().min(1).optional(),
  tint: z.string().min(1).optional(),
  commander: z.string().min(1).optional(),
  singleton_ok: z.boolean().optional(),
  dispatch_target: z.string().min(1).optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

export const LaunchResponseSchema = z.object({
  ok: z.boolean(),
  seat_id: z.string(),
  handover: z.boolean(), // false when the reg-audit refused
  missing_attestations: z.array(z.string()),
  reason: z.string().nullable(),
});
export type LaunchResponse = z.infer<typeof LaunchResponseSchema>;

// ── Close operation (rung 3) — the sanctioned remote-close verb ───────────
// Executes the terminal-retirement chain for bound estate seats: reg.retired +
// reg.process_reaped (the agent process is reaped) + reg.seat_cleared (binding
// cleared → seat returns to the freelist). The persistent estate PANE is kept
// and respawned bare, so the estate stays standing. Reap-first, attest-after: the
// three events are recorded only once the process is confirmed reaped, so a
// retire-with-live-process is unspellable — a failed reap refuses loud, changing
// nothing (spec §4: retired is not terminal until process_reaped + seat_cleared).
//
// Closing is an overseer capability: source_agent_id must resolve to a
// registered binding holding CLOSE_REQUIRED_RANK. Graceful by default — an
// agent whose recorded activity is 'working' (mid-turn) refuses absent force.
// Bulk is first-class: one request selects explicit targets OR one page's
// closable agents OR every closable agent, and every selected target retires
// individually with its own facts — never a page rebuild.
export const CLOSE_REQUIRED_RANK = 'overseer';

export const CloseRequestSchema = z
  .object({
    schema_version: z.number().int(),
    source_agent_id: z.string().min(1), // caller — never a tmux %id
    // Exactly one selector:
    targets: z.array(z.string().min(1)).min(1).optional(), // canonical seat ids OR agent ids
    page: z.string().min(1).optional(), // every closable agent on one page
    all_idle: z.literal(true).optional(), // every closable agent estate-wide
    // Explicit-targets only: override the mid-turn gate for a hung agent.
    // Filters are inherently graceful — force never combines with them.
    force: z.boolean().optional(),
  })
  .superRefine((req, ctx) => {
    const selectors = [req.targets, req.page, req.all_idle].filter((value) => value !== undefined).length;
    if (selectors !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: 'exactly one selector: targets | page | all_idle' });
    }
    if (req.force && !req.targets) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['force'], message: 'force applies only to explicit targets' });
    }
  });
export type CloseRequest = z.infer<typeof CloseRequestSchema>;

// One verdict per selected target — a refused sibling never blocks a close.
export const CloseVerdictSchema = z.object({
  target: z.string(),
  seat_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  closed: z.boolean(), // true = full retire chain attested + seat freed
  reason: z.string().nullable(),
});
export type CloseVerdict = z.infer<typeof CloseVerdictSchema>;

export const CloseResponseSchema = z.object({
  ok: z.boolean(), // true = every selected target closed (selection non-empty)
  closed_count: z.number().int(),
  refused_count: z.number().int(),
  verdicts: z.array(CloseVerdictSchema),
  // Request-level refusal (auth, schema, empty selection); null when the
  // per-target verdicts carry the story.
  reason: z.string().nullable(),
});
export type CloseResponse = z.infer<typeof CloseResponseSchema>;

// ── Stop ingestion (rung 3) — the stop-hook's door into the daemon ───────────
// A stop-hook reports that an agent's turn ended. The door has three honest
// outcomes, none of them a blind swallow:
//   - recorded: a fresh act.stop_reported for a currently-bound, not-yet-stopped
//     agent (activity → stopped).
//   - deduped: a repeat/late stop for an agent already stopped or already
//     closed — writes act.receipt_deduped (idempotent, NO blind swallow).
//   - refused: a stop for an agent that NEVER walked through /agents/launch (never
//     bound) — a ghost. Refused loud at admission; nothing recorded, so no
//     phantom row and no re-firing subscription can exist (the 77f7cfb4 class).
export const StopRequestSchema = z.object({
  agent_id: z.string().min(1), // canonical agent id ONLY — never a tmux %id
  schema_version: z.number().int(),
  content: z.string().optional(),
  stop_event_id: z.string().min(1).optional(),
});
export type StopRequest = z.infer<typeof StopRequestSchema>;

export const STOP_REFUSAL_REASONS = ['no_such_agent', 'schema_version_mismatch'] as const;
export type StopRefusalReason = (typeof STOP_REFUSAL_REASONS)[number];
export const StopRefusalReasonSchema = z.enum(STOP_REFUSAL_REASONS);

export const StopReceiptSchema = z.object({
  ok: z.literal(true),
  agent_id: z.string(),
  recorded: z.boolean(), // true = stop_reported appended; false = deduped
  deduped: z.boolean(),
  activity: ActivityStateSchema.nullable(), // resulting activity for the agent
});
export type StopReceipt = z.infer<typeof StopReceiptSchema>;

export const StopRefusalSchema = z.object({
  ok: z.literal(false),
  refused: z.literal(true),
  reason: StopRefusalReasonSchema,
  agent_id: z.string(),
});
export type StopRefusal = z.infer<typeof StopRefusalSchema>;

export const ReconcileResponseSchema = z.object({
  ok: z.boolean(),
  replayed_events: z.number().int(),
  replay_ms: z.number(),
  bindings: z.number().int(),
  freelist: z.number().int(),
  agents: z.number().int(),
  // New contradictions flagged this reconcile pass, and all currently-open ones.
  new_contradictions: z.array(OpenContradictionSchema),
  open_contradictions: z.array(OpenContradictionSchema),
  // Bring-up mode: any open contradiction is p0. ok=false, fail loud.
  p0: z.boolean(),
});
export type ReconcileResponse = z.infer<typeof ReconcileResponseSchema>;

// The estate observation view served under `GET /tmux/read/estate` — txd's ONLY
// public read surface ([[txd-extraction-spec]] §6). "entities" is DEAD as public
// API vocabulary (planes name their concrete domain); the rows keep the ruled
// activity-board projection shape (spec §10) — internals unchanged.
//
// The old per-entity event-history serving (`GET /entities/:id/events`) is
// REMOVED: agent-biography serving is not txd's job. The internal event stream
// remains txd's private source of truth for replay/reconcile only.
export const EstateReadResponseSchema = z.object({
  schema_version: z.number().int(),
  rows: z.array(ActivityBoardRowSchema),
  tints: HealthSchema.shape.tints,
});
export type EstateReadResponse = z.infer<typeof EstateReadResponseSchema>;

export const EstateRotateRequestSchema = z.object({
  schema_version: z.number().int(),
  force: z.boolean().default(false),
  scope: z.enum(['estate', 'page', 'pane']).default('estate'),
  page: z.string().min(1).optional(),
  pane: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.scope === 'estate' && (value.page !== undefined || value.pane !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'estate scope accepts no page or pane target' });
  }
  if (value.scope === 'page' && (value.page === undefined || value.pane !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'page scope requires page and accepts no pane target' });
  }
  if (value.scope === 'pane' && (value.pane === undefined || value.page !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'pane scope requires pane and accepts no page target' });
  }
});
export type EstateRotateRequest = z.infer<typeof EstateRotateRequestSchema>;

export const EstateRotateResponseSchema = z.object({
  ok: z.boolean(),
  rotation_id: z.string().nullable(),
  accepted: z.boolean(),
  force: z.boolean(),
  scope: z.enum(['estate', 'page', 'pane']),
  seats: z.array(z.string()),
  bound_seats: z.array(z.string()),
  foreground_workloads: z.array(z.object({ seat_id: z.string(), command: z.string() })),
  reason: z.string().nullable(),
});
export type EstateRotateResponse = z.infer<typeof EstateRotateResponseSchema>;

// `pane-died`/`pane-exited` fire in the dying pane's own hook context, so
// their page claim is trustworthy and required. A kill command fires only
// `after-kill-*`, whose format context is the ACTIVE window — any page named
// there would lie — so `pane-killed` is page-less and txd sweeps the estate.
export const TmuxLifecycleEventRequestSchema = z.object({
  schema_version: z.number().int(),
  event: z.enum(['pane-died', 'pane-exited', 'pane-killed']),
  page: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if ((value.event === 'pane-killed') !== (value.page === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'pane-killed is page-less; pane-died and pane-exited require their page' });
  }
});
export type TmuxLifecycleEventRequest = z.infer<typeof TmuxLifecycleEventRequestSchema>;

export const TmuxLifecycleEventResponseSchema = z.object({
  ok: z.boolean(),
  event: z.enum(['pane-died', 'pane-exited', 'pane-killed']),
  page: z.string().nullable(),
  reconstructed: z.boolean(),
  // The exact seats whose processes were replaced. A dead pane earns a
  // pane-scoped respawn of that pane alone; siblings are never in this list
  // unless the window itself lost a split and the whole border was rebuilt.
  reset_seats: z.array(z.string()),
  rotation_ids: z.array(z.string()),
  reason: z.string().nullable(),
});
export type TmuxLifecycleEventResponse = z.infer<typeof TmuxLifecycleEventResponseSchema>;

// Communications are admitted as one atomic request.  `message` is opaque;
// txd never parses or normalizes it.  Pages are resolved to an immutable list
// before the accepted event is appended.
export const MAX_COMM_MESSAGE_BYTES = 64 * 1024;
export const COMM_WAIT_TIMEOUT_MS = 7 * 60 * 1000;
export const CommRequestSchema = z.object({
  schema_version: z.number().int(),
  source_agent_id: z.string().min(1),
  target: z.string().min(1).optional(),
  page: z.string().min(1).optional(),
  message: z.string().refine((value) => new TextEncoder().encode(value).length <= MAX_COMM_MESSAGE_BYTES, 'message exceeds maximum encoded size'),
  ask: z.boolean().default(false),
  reply: z.boolean().default(false),
}).superRefine((value, ctx) => {
  const modes = Number(value.target !== undefined) + Number(value.page !== undefined) + Number(value.reply);
  if (modes !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one of target, page, or reply is required' });
  if (value.reply && value.ask) ctx.addIssue({ code: 'custom', message: 'reply cannot also ask' });
});
export type CommRequest = z.infer<typeof CommRequestSchema>;

export const CommTargetSchema = z.object({ agent_id: z.string(), seat_id: z.string(), persona: z.string().nullable() });
export type CommTarget = z.infer<typeof CommTargetSchema>;
export const CommAcceptedSchema = z.object({
  ok: z.literal(true), message_id: z.string(), ask_id: z.string().nullable(),
  source_agent_id: z.string(), targets: z.array(CommTargetSchema), bytes_sent: z.boolean(), event_ids: z.array(z.number().int()),
});
export type CommAccepted = z.infer<typeof CommAcceptedSchema>;

export const CommHookSchema = z.object({
  schema_version: z.number().int(), agent_id: z.string().min(1), message_id: z.string().min(1).optional(),
  content: z.string().optional(), stop_event_id: z.string().min(1).optional(),
});
export type CommHook = z.infer<typeof CommHookSchema>;

export const CommWaitRequestSchema = z.object({
  schema_version: z.number().int(), ask_id: z.string().min(1), subscriber_agent_id: z.string().min(1),
  timeout_ms: z.number().int().min(COMM_WAIT_TIMEOUT_MS).default(COMM_WAIT_TIMEOUT_MS),
});
export type CommWaitRequest = z.infer<typeof CommWaitRequestSchema>;
export const CommCallbackSchema = z.object({ target: CommTargetSchema, content: z.string(), assertion_event_id: z.number().int(), source: z.enum(['reply', 'stop']) });
export type CommCallback = z.infer<typeof CommCallbackSchema>;
export const CommWaitResponseSchema = z.object({ ask_id: z.string(), complete: z.boolean(), callbacks: z.array(CommCallbackSchema), outstanding: z.array(CommTargetSchema) });
export type CommWaitResponse = z.infer<typeof CommWaitResponseSchema>;

// Plan mode is a semantic deliberate action, not a generic text/key send.
// Callers name a logical identity and intent; txd resolves the bound engine and
// owns the harness-specific input and read-back evidence below the tmux membrane.
export const MODE_TRANSITION_INTENTS = ['enter_plan', 'toggle_plan', 'approve_plan'] as const;
export type ModeTransitionIntent = (typeof MODE_TRANSITION_INTENTS)[number];
export const ModeTransitionIntentSchema = z.enum(MODE_TRANSITION_INTENTS);

export const MODE_TRANSITION_TRIGGERS = ['operator', 'preplan', 'context_cycle'] as const;
export type ModeTransitionTrigger = (typeof MODE_TRANSITION_TRIGGERS)[number];
export const ModeTransitionTriggerSchema = z.enum(MODE_TRANSITION_TRIGGERS);

export const AGENT_MODE_STATES = ['work', 'plan', 'unknown'] as const;
export type AgentModeState = (typeof AGENT_MODE_STATES)[number];
export const AgentModeStateSchema = z.enum(AGENT_MODE_STATES);

export const MODE_TRANSITION_MECHANISMS = ['none', 'slash_command', 'mode_cycle', 'dialog_accept'] as const;
export type ModeTransitionMechanism = (typeof MODE_TRANSITION_MECHANISMS)[number];
export const ModeTransitionMechanismSchema = z.enum(MODE_TRANSITION_MECHANISMS);

export const ModeTransitionRequestSchema = z.strictObject({
  schema_version: z.number().int(),
  target: z.string().min(1),
  intent: ModeTransitionIntentSchema,
  trigger: ModeTransitionTriggerSchema,
});
export type ModeTransitionRequest = z.infer<typeof ModeTransitionRequestSchema>;

export const ModeTransitionResponseSchema = z.object({
  ok: z.boolean(),
  target: z.string(),
  seat_id: z.string(),
  agent_id: z.string(),
  engine: z.enum(['claude', 'codex']),
  intent: ModeTransitionIntentSchema,
  trigger: ModeTransitionTriggerSchema,
  before: AgentModeStateSchema,
  after: AgentModeStateSchema,
  changed: z.boolean(),
  verified: z.boolean(),
  mechanism: ModeTransitionMechanismSchema,
  event_ids: z.array(z.number().int()),
  reason: z.string().nullable(),
});
export type ModeTransitionResponse = z.infer<typeof ModeTransitionResponseSchema>;
