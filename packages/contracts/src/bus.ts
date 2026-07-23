// Central event bus vocabulary (`@terminus-os/contracts`).
//
// The bus is generic egress fully decoupled from consumers: an emitter appends
// ONE event to the central journal (`bus.events`, busd its single writer) and a
// config table (`bus.subscriptions`) decides which services receive it — zero,
// one, or all, invisible to the emitter. Delivery is at-least-once, strictly
// in seq order per subscription, resumed from a durable per-subscriber cursor
// (transactional outbox — no broker, no second queue).
//
// Hooks are NOT special: they are the first tenant, landing as `hook.<type>`
// in the dotted event_type namespace via busd's hook shim door. The `hook.`
// prefix is therefore RESERVED — the generic publish door rejects it, so a
// synthetic hook can never be forged past the shim.
//
// Subscribers MUST 2xx events they do not care about (ack ≠ consume): a
// subscription's delivery is head-of-line — busd never skips — so a non-2xx
// on an irrelevant event would wedge that subscriber's lane. Non-2xx is
// reserved for genuine contract skew, which SHOULD block loudly.

import { z } from "zod";

// The bus envelope version. busd stamps it on every delivery; subscribers pin
// it exactly. Additive vocabulary = minor bump; breaking changes land busd +
// subscribers in one PR.
export const BUS_SCHEMA_VERSION = 1;

// Dotted lowercase namespace: `<tenant>.<name>` (e.g. `hook.stop`,
// `txd.act.stop_reported` later). At least two segments — an unqualified name
// carries no tenant and is refused.
export const BusEventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "bus event_type must be dotted lowercase (`tenant.name`)",
  );
export type BusEventType = z.infer<typeof BusEventTypeSchema>;

// Which busd door an event entered through. `hooks` = the hook shim
// (/ingress/hooks/<type>, proxy fan-in); `events` = the generic publish door
// (/ingress/events, loopback emitters).
export const BUS_INGRESSES = ["hooks", "events"] as const;
export type BusIngress = (typeof BUS_INGRESSES)[number];
export const BusIngressSchema = z.enum(BUS_INGRESSES);

// Journal provenance: how the event reached busd. `transport_receipt` is the
// edge-proxy receipt header (null when the emitter hit busd directly);
// `machine` is busd's own box identity (fail-loud config, never guessed).
export const BusProvenanceSchema = z.object({
  ingress: BusIngressSchema,
  transport_receipt: z.string().nullable(),
  machine: z.string().min(1),
});
export type BusProvenance = z.infer<typeof BusProvenanceSchema>;

// ── Journal record — the 7 append-only columns, nothing derived ─────────────
// Payload holds DUMB FACTS only. busd assigns `seq` (global monotonic, single
// writer) and `recorded_at`; `occurred_at` is the emitter's attested clock,
// stored verbatim (skew is visible data — the 0002 idiom).
export const BusEventInputSchema = z.object({
  event_type: BusEventTypeSchema,
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  provenance: BusProvenanceSchema,
  occurred_at: z.string().min(1),
});
export type BusEventInput = z.infer<typeof BusEventInputSchema>;

export const BusEventRecordSchema = BusEventInputSchema.extend({
  seq: z.number().int(),
  recorded_at: z.string(),
});
export type BusEventRecord = z.infer<typeof BusEventRecordSchema>;

// ── The generic publish door (`POST /ingress/events`) ───────────────────────
// `hook.*` is reserved for the hook shim door and rejected here by
// construction. Provenance is busd's to stamp, never the emitter's to claim.
export const BusPublishRequestSchema = z.object({
  schema_version: z.number().int(),
  event_type: BusEventTypeSchema.refine(
    (t) => !t.startsWith("hook."),
    "hook.* is reserved: hooks enter only via the hook shim door",
  ),
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: z.string().min(1),
});
export type BusPublishRequest = z.infer<typeof BusPublishRequestSchema>;

export const BusPublishResponseSchema = z.object({
  ok: z.literal(true),
  seq: z.number().int(),
  event_type: BusEventTypeSchema,
});
export type BusPublishResponse = z.infer<typeof BusPublishResponseSchema>;

// ── Delivery envelope — one full journal row per POST ───────────────────────
// busd POSTs this to a subscription's delivery_url. 2xx advances the cursor;
// anything else retries the SAME event with backoff (at-least-once, in order,
// never skipped).
export const BusDeliverySchema = z.object({
  schema_version: z.number().int(),
  subscription: z.string().min(1),
  event: BusEventRecordSchema,
});
export type BusDelivery = z.infer<typeof BusDeliverySchema>;

// ── Config + operational rows (Zod boundary for busd's typed reads) ─────────
export const BusSubscriptionRowSchema = z.object({
  name: z.string().min(1),
  delivery_url: z.url(),
  event_pattern: z.string().min(1), // SQL LIKE over event_type — matching lives in the delivery query
  active: z.boolean(),
});
export type BusSubscriptionRow = z.infer<typeof BusSubscriptionRowSchema>;

export const BusLagRowSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  event_pattern: z.string(),
  acked_seq: z.number().int().nullable(), // null = cursor never seeded (runbook step outstanding)
  lag: z.number().int(),
});
export type BusLagRow = z.infer<typeof BusLagRowSchema>;

export const BusHealthSchema = z.object({
  ok: z.boolean(),
  service: z.literal("busd"),
  schema_version: z.number().int(),
  version: z.string(),
  git_sha: z.string(),
  bun: z.string(),
  machine: z.string(),
  events: z.number().int(),
  subscriptions: z.array(BusLagRowSchema),
});
export type BusHealth = z.infer<typeof BusHealthSchema>;
