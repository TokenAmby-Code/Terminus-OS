// Strict semantic mirror of registrationd's authoritative Agent contract.
// Token-Fleet CI compares the marked block byte-for-byte.

import { z } from "zod";

// AGENT_CONTRACT_MIRROR_START
export const AGENT_SCHEMA_VERSION = 6;

export const AgentIdSchema = z.string().uuid();
export const BirthGenerationSchema = z.string().uuid();
export const PaneGenerationSchema = z.string().uuid();
export const EngineSchema = z.enum(["claude", "codex"]);
export type Engine = z.infer<typeof EngineSchema>;
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const GitHeadSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const TransportPathSchema = z.string()
  .regex(/^\/[A-Za-z0-9._/-]+$/)
  .refine((path) => path.slice(1).split("/").every(
    (component) => component.length > 0 && component !== "." && component !== "..",
  ), {
    message: "path must be canonical and contain no empty or dot segments",
  });

export const WorktreeBindingSchema = z.object({
  repository: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  branch: z.string().min(1),
  replay_id: z.string().uuid(),
  path: TransportPathSchema,
  head_sha: GitHeadSchema,
}).strict();
export type WorktreeBinding = z.infer<typeof WorktreeBindingSchema>;

export const InstructionSourceSchema = z.object({
  kind: z.enum(["file", "inline", "continuity"]),
  reference: z.string().min(1),
  digest: Sha256Schema,
}).strict();

export const PersonaPackageSchema = z.object({
  persona: z.string().min(1),
  rank: z.string().min(1).nullable(),
  commander: z.string().min(1).nullable(),
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  // The persona's synth voice_identity; null for a silent persona. Voice is
  // persona-level identity, so it lives in the package, never beside it.
  voice: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  working_directory: TransportPathSchema.optional(),
  continuity_references: z.array(z.string().min(1)),
  instruction_package: z.object({
    digest: Sha256Schema,
    sources: z.array(InstructionSourceSchema),
    cache_path: TransportPathSchema,
  }).strict(),
}).strict().superRefine((persona, context) => {
  const durableRank = persona.rank === "overseer" || persona.rank === "primarch";
  if (!durableRank && persona.working_directory !== undefined) {
    context.addIssue({ code: "custom", path: ["working_directory"], message: "cattle packages do not own a working directory" });
  }
});
export type PersonaPackage = z.infer<typeof PersonaPackageSchema>;

export const PlacementSchema = z.object({
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  machine: z.string().min(1),
  kind: z.enum(["local", "ssh"]),
  wrapper_pid: z.number().int().positive(),
  transport_witnesses: z.record(z.string(), z.unknown()),
}).strict();

export const ResourceReceiptSchema = z.object({
  kind: z.literal("worktree"),
  authority: z.string().min(1),
  receipt_id: z.string().min(1),
  generation: z.string().min(1),
}).strict();

export const AgentSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  registered_at: z.string().datetime({ offset: true }),
  engine: EngineSchema,
  launch: z.object({
    argv: z.array(z.string()),
    requested_cwd: z.string().startsWith("/"),
  }).strict(),
  placement: PlacementSchema,
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  persona: PersonaPackageSchema.nullable(),
  resources: z.array(ResourceReceiptSchema),
}).strict();
export type Agent = z.infer<typeof AgentSchema>;

export const WrapperStartHookSchema = z.object({
  hook_request_id: z.string().uuid(),
  engine: EngineSchema,
  cwd: z.string().startsWith("/"),
  machine: z.string().min(1),
  wrapper_pid: z.number().int().positive(),
  claimed_pane_id: z.string().min(1),
  argv: z.array(z.string()),
  placement_hints: z.record(z.string(), z.unknown()),
}).strict();
export type WrapperStartHook = z.infer<typeof WrapperStartHookSchema>;

export const RegistrationPreparedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  hook_request_id: z.string().uuid(),
  engine: EngineSchema,
  wrapper_pid: z.number().int().positive(),
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  persona: PersonaPackageSchema.nullable(),
  prepared_at: z.string().datetime({ offset: true }),
}).strict();
export type RegistrationPrepared = z.infer<typeof RegistrationPreparedSchema>;

export const PaneAttestedSchema = z.object({
  hook_request_id: z.string().uuid(),
  claimed_pane_id: z.string().min(1),
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  machine: z.string().min(1),
  // The seat's placement kind as the estate declares it — the pane itself is
  // always local; an ssh seat's pane hosts the local wrapper owning the
  // transport into the remote envelope.
  kind: z.enum(["local", "ssh"]),
  // The identity txd's launch composition carried into this pane, attested
  // back to registrationd as the one identity channel. Null when the pane's
  // launch predates or lacks a composition (a perpetual seat's relaunch);
  // registrationd then mints at prepare.
  agent_id: AgentIdSchema.nullable(),
  wrapper_pid: z.number().int().positive(),
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  worktree: WorktreeBindingSchema.nullable(),
  process_witnesses: z.record(z.string(), z.unknown()),
}).strict();
export type PaneAttested = z.infer<typeof PaneAttestedSchema>;

export const PaneRefusedSchema = z.object({
  hook_request_id: z.string().uuid(),
  claimed_pane_id: z.string().min(1),
  machine: z.string().min(1),
  wrapper_pid: z.number().int().positive(),
  reason: z.enum([
    "wrapper_process_missing",
    "wrapper_not_in_managed_pane",
    "pane_dead",
    "pane_generation_missing",
    "ambiguous_placement",
    "process_changed",
    "physical_registration_unconfigured",
  ]),
}).strict();
export type PaneRefused = z.infer<typeof PaneRefusedSchema>;

// The birth reply carries package and pane facts only — never identity.
// AGENT_ID enters the pane environment through txd's launch composition;
// the wrapper is a hooks bot and no reply may teach it who the agent is.
export const WrapperLaunchReplySchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  working_directory: TransportPathSchema,
  instruction_package: z.object({
    digest: Sha256Schema,
    cache_path: TransportPathSchema,
  }).strict().nullable(),
}).strict();
export type WrapperLaunchReply = z.infer<typeof WrapperLaunchReplySchema>;

export const PhysicalDeclarationSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  engine: EngineSchema,
  wrapper_pid: z.number().int().positive(),
  // registrationd's assertion of who this agent is. txd checks it against the
  // tmux estate before it signs off — the declaration is a claim, not a fact.
  persona: z.string().min(1).nullable(),
  rank: z.string().min(1).nullable(),
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
}).strict();
export type PhysicalDeclaration = z.infer<typeof PhysicalDeclarationSchema>;

export const PlacementAttestedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  machine: z.string().min(1),
  kind: z.enum(["local", "ssh"]),
  wrapper_pid: z.number().int().positive(),
  transport_witnesses: z.record(z.string(), z.unknown()),
}).strict();
export type PlacementAttested = z.infer<typeof PlacementAttestedSchema>;

export const LifecycleReadySchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  ready_at: z.string().datetime({ offset: true }),
  evidence: z.object({
    registration_prepared: z.number().int().positive(),
    placement_attested: z.number().int().positive(),
  }).strict(),
}).strict();
export type LifecycleReady = z.infer<typeof LifecycleReadySchema>;

// registrationd orchestrates the launch: it asks txd for a worker placement.
// A dispatch never names a persona and never names a chapter — the seat the
// agent lands in is the only input to persona allocation. The target names
// either a page (txd autofills a free seat on it) or one exact seat.
export const DispatchTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    page: z.string().min(1),
    stack_page: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal("seat"),
    seat_id: z.string().min(1),
    stack_page: z.string().min(1).optional(),
  }).strict(),
]);
export type DispatchTarget = z.infer<typeof DispatchTargetSchema>;

export const DispatchRequestedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  dispatch_id: z.string().uuid(),
  // registrationd mints the agent's identity at dispatch; txd carries it into
  // the pane environment through launch composition. Identity never rides the
  // birth reply.
  agent_id: AgentIdSchema,
  machine: z.string().min(1),
  target: DispatchTargetSchema,
  engine: EngineSchema,
  worktree: WorktreeBindingSchema.optional(),
  // The orders the agent is born with. Absent for a bodiless dispatch; never
  // empty, because empty orders are not orders. Carried byte-for-byte: a brief
  // that arrives subtly altered is worse than one that fails to arrive.
  prompt: z.string().min(1).optional(),
}).strict();
export type DispatchRequested = z.infer<typeof DispatchRequestedSchema>;

export const DispatchAttestedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  dispatch_id: z.string().uuid(),
  machine: z.string().min(1),
  seat_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  engine: EngineSchema,
}).strict();
export type DispatchAttested = z.infer<typeof DispatchAttestedSchema>;

// One candidate seat's disqualifier, as the estate store and tmux attest it.
export const SeatDisqualifierSchema = z.enum([
  "bound",
  "launching",
  "abandoned",
  "reset_pending",
  "dead",
  "foreign_process",
]);
export type SeatDisqualifier = z.infer<typeof SeatDisqualifierSchema>;

// A refusal names the seat-level truth: `seats` carries the disqualifier for
// every candidate the refusal accounts for — each page seat on an autofill
// refusal, the one named seat on a seat-target refusal.
export const DispatchRefusedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  dispatch_id: z.string().uuid(),
  machine: z.string().min(1),
  target: DispatchTargetSchema,
  engine: EngineSchema,
  reason: z.enum([
    "page_absent",
    "seat_absent",
    "no_free_seat",
    "seat_bound",
    "seat_launching",
    "seat_abandoned",
    "seat_reset_pending",
    "pane_dead",
    "seat_generation_unattested",
    "seat_start_failed",
  ]),
  seats: z.array(z.object({
    seat_id: z.string().min(1),
    state: SeatDisqualifierSchema,
  }).strict()),
}).strict();
export type DispatchRefused = z.infer<typeof DispatchRefusedSchema>;

// A perpetual seat is one the estate keeps staffed. txd observes the vacancy —
// no binding, and a pane running nothing of its own — and says so; it does not
// staff the seat itself. Identity is registrationd's to mint, so the seat is
// filled by the same dispatch every other agent is born through: one birth
// path, and no way for a pane to come up carrying no identity.
export const PerpetualSeatVacantSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  machine: z.string().min(1),
  seat_id: z.string().min(1),
  // The engine the seat is declared to run. The declaration is txd's; which
  // agent arrives to run it is not.
  engine: EngineSchema,
}).strict();
export type PerpetualSeatVacant = z.infer<typeof PerpetualSeatVacantSchema>;

// The occupancy census: the symmetric partner of the vacancy sweep above. The
// sweep says which declared seats the estate wants filled; the census says who
// is seated. txd asserts it once, at boot fold completion, from the binding
// truth it has just finished folding — not on a timer and not as a repeating
// sweep.
//
// The assertion is COMPLETE over the machine: these and ONLY these agents are
// seated on it. Completeness is the whole point. A departure whose own
// `agent.retired` never reached the journal leaves a consumer holding a seat
// forever, because no further event about that agent is ever coming — and a
// seat-keyed reconciliation cannot reach it either when the seat belongs to an
// estate generation that no longer exists. Only a complete roster of the
// living reaches an agent nothing else will ever speak about again.
//
// `taken_at` is what makes absence safe to read. txd sees an agent only once it
// is seated, so absence means departed ONLY for a placement the estate made
// strictly before that instant; a birth placed after it is not missing from the
// roster, it is not yet in it. A consumer that reads absence without comparing
// `taken_at` releases live agents — the leak pointed the other way, and silent.
//
// A census terminalizes nothing. txd owns the reactive retirement leg and says
// so through `agent.retired`; this says only who is sitting where, which is the
// question an occupancy projection was answering wrong.
export const SeatOccupantSchema = z.object({
  seat_id: z.string().min(1),
  // The identity the seat actually carries, not necessarily one a birth minted:
  // txd's launch door admits an operator-supplied identity, and a roster that
  // refused to represent one would go dark on the whole machine rather than
  // omit a line. A consumer matches this against its own rows; an identity that
  // matches nothing releases nothing.
  agent_id: z.string().min(1),
  birth_generation: BirthGenerationSchema.nullable(),
  pane_generation: PaneGenerationSchema.nullable(),
  // A bound-but-unregistered seat is occupied; its birth simply has not
  // completed. txd attests the occupancy either way — what a consumer's own
  // birth row may conclude from an incomplete birth is the consumer's ruling.
  registered: z.boolean(),
}).strict();
export type SeatOccupant = z.infer<typeof SeatOccupantSchema>;

export const EstateOccupancyCensusSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  machine: z.string().min(1),
  // The estate declaration the fold observed. A census speaks for the estate
  // generation it was taken in and no other.
  configuration: z.object({
    generation: z.string().min(1),
    digest: Sha256Schema,
  }).strict(),
  occupied: z.array(SeatOccupantSchema),
  taken_at: z.string().datetime({ offset: true }),
}).strict();
export type EstateOccupancyCensus = z.infer<typeof EstateOccupancyCensusSchema>;

// Post-birth, registrationd never initiates retirement. txd publishes this at
// the point it writes reg.retired — the reactive leg of the retirement
// authority split; lifecycled owns the proactive leg. Consumers terminalize
// the agent row this identifies; birth_generation and pane_generation are
// nullable because txd attests what the binding actually carried.
export const RETIREMENT_CAUSES = ["close", "estate_reset", "topology_migration"] as const;
export const RetirementCauseSchema = z.enum(RETIREMENT_CAUSES);
export type RetirementCause = z.infer<typeof RetirementCauseSchema>;

export const AgentRetiredSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema.nullable(),
  seat_id: z.string().min(1),
  pane_generation: PaneGenerationSchema.nullable(),
  machine: z.string().min(1),
  cause: RetirementCauseSchema,
  retired_at: z.string().datetime({ offset: true }),
}).strict();
export type AgentRetired = z.infer<typeof AgentRetiredSchema>;

// txd's close-of-unregistered signal: a bound-but-unregistered binding closed
// — its pane died or its seat was reset before lifecycle_ready — so the birth
// can never complete. registrationd consumes this to abort the birth;
// terminalizing the row is the chapter-lock release. Post-birth closes publish
// agent.retired, never this event, and a binding carrying no birth generation
// identifies no birth, so it publishes nothing.
export const UnregisteredClosedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  seat_id: z.string().min(1),
  pane_generation: PaneGenerationSchema.nullable(),
  machine: z.string().min(1),
  cause: RetirementCauseSchema,
  closed_at: z.string().datetime({ offset: true }),
}).strict();
export type UnregisteredClosed = z.infer<typeof UnregisteredClosedSchema>;

export const PLACEMENT_REFUSAL_REASONS = [
  "physical_configuration_skew",
  "physical_declaration_contradicted",
  "persona_seat_incoherent",
  "physical_binding_conflict",
  "tint_attestation_failed",
  "physical_binding_incomplete",
  // Seat-aware placement audit: the declared placement's kind must match the
  // seat's declared kind, an ssh claim must name the seat's configured
  // target, and the claimed launch nonce must match the one txd minted for
  // the live pane generation.
  "placement_kind_incoherent",
  "placement_machine_incoherent",
  "launch_nonce_contradicted",
] as const;
export const PlacementRefusalReasonSchema = z.enum(PLACEMENT_REFUSAL_REASONS);
export type PlacementRefusalReason = z.infer<typeof PlacementRefusalReasonSchema>;

// txd's Door-1 audit refused the declared placement. No binding stands (a
// partial binding is aborted fail-dark before this publishes), so the birth
// can never complete: registrationd aborts it on this evidence.
export const PlacementRefusedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1),
  pane_generation: PaneGenerationSchema,
  machine: z.string().min(1),
  reason: PlacementRefusalReasonSchema,
  refused_at: z.string().datetime({ offset: true }),
}).strict();
export type PlacementRefused = z.infer<typeof PlacementRefusedSchema>;

export const REGISTRATION_ABORT_REASONS = [
  "pane_refused",
  "worktree_refused",
  "wrapper_reply_expired",
  "placement_refused",
  "unregistered_closed",
] as const;
export const RegistrationAbortReasonSchema = z.enum(REGISTRATION_ABORT_REASONS);
export type RegistrationAbortReason = z.infer<typeof RegistrationAbortReasonSchema>;

// registrationd's only retirement authority: aborting its own partial birth
// transactions. The birth row is terminal in the same store transaction that
// enqueues this event, which is the whole lock release — chapter held-ness is
// a projection over non-terminal births and live agents. txd consumes this to
// close and un-tint any binding still standing. Post-birth cleanup is
// agent.retired, never this event; pane_id and persona are null when the
// birth failed before a pane was attested or a persona allocated.
export const RegistrationAbortedSchema = z.object({
  schema_version: z.literal(AGENT_SCHEMA_VERSION),
  agent_id: AgentIdSchema,
  birth_generation: BirthGenerationSchema,
  pane_id: z.string().min(1).nullable(),
  pane_generation: PaneGenerationSchema.nullable(),
  persona: z.string().min(1).nullable(),
  reason: RegistrationAbortReasonSchema,
  aborted_at: z.string().datetime({ offset: true }),
}).strict();
export type RegistrationAborted = z.infer<typeof RegistrationAbortedSchema>;
// AGENT_CONTRACT_MIRROR_END
