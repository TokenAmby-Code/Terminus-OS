import { z } from "zod";
import { BusEventTypeSchema } from "./bus.ts";

export const REPLAY_SCHEMA_VERSION = 1;

const lowercaseUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ReplayIdSchema = z.string().regex(lowercaseUuid, "replay_id must be a lowercase UUID");
export const EventIdSchema = z.string().regex(lowercaseUuid, "event_id must be a lowercase UUID");
export const CanonicalRequestHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "request_hash must be lowercase SHA-256 hex");

const forbiddenKey =
  /authorization|authentication|cookie|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key|access[_-]?key|client[_-]?key|signing[_-]?key/i;
const forbiddenAuthKey = /(?:^|[_-])auth(?:$|[_-])/i;
const forbiddenCamelAuthKey = /auth[A-Z]/;
const forbiddenString = [
  /^bearer\s+\S+/i,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

function isForbiddenKey(key: string): boolean {
  return forbiddenKey.test(key) || forbiddenAuthKey.test(key) || forbiddenCamelAuthKey.test(key);
}

function findSecret(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecret(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "string" && forbiddenString.some((pattern) => pattern.test(value))) return path;
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key)) return `${path}.${key}`;
    const found = findSecret(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

const SafeFactsSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  const path = findSecret(value);
  if (path) context.addIssue({ code: "custom", message: `credential-shaped field is forbidden at ${path}` });
});

export const ReplayProvenanceSchema = SafeFactsSchema.and(z.object({
  machine: z.string().min(1),
  ingress: z.string().min(1),
}));

export const ReplayEventInputSchema = z.object({
  replay_id: ReplayIdSchema,
  event_id: EventIdSchema,
  event_type: BusEventTypeSchema,
  schema_version: z.literal(REPLAY_SCHEMA_VERSION),
  source: z.string().min(1),
  provenance: ReplayProvenanceSchema,
  causation_event_id: EventIdSchema.nullable(),
  occurred_at: z.iso.datetime({ offset: true }),
  payload: SafeFactsSchema,
}).strict();
export type ReplayEventInput = z.infer<typeof ReplayEventInputSchema>;

export const ReplayEventRecordSchema = ReplayEventInputSchema.extend({
  sequence: z.number().int().positive(),
  recorded_at: z.iso.datetime({ offset: true }),
}).strict();
export type ReplayEventRecord = z.infer<typeof ReplayEventRecordSchema>;

export const ReplayAdmissionSchema = z.object({
  replay_id: ReplayIdSchema,
  request_hash: CanonicalRequestHashSchema,
  event: ReplayEventInputSchema,
}).strict().superRefine((value, context) => {
  if (value.replay_id !== value.event.replay_id) {
    context.addIssue({ code: "custom", path: ["event", "replay_id"], message: "event replay_id must match admission replay_id" });
  }
  if (value.event.causation_event_id !== null) {
    context.addIssue({ code: "custom", path: ["event", "causation_event_id"], message: "initial event cannot have causation" });
  }
});
export type ReplayAdmission = z.infer<typeof ReplayAdmissionSchema>;

export const ReplayAppendSchema = z.object({
  event: ReplayEventInputSchema,
}).strict();
export type ReplayAppend = z.infer<typeof ReplayAppendSchema>;

export const ReplayDeliveryStatusSchema = z.object({
  event_id: EventIdSchema,
  subscription: z.string().min(1),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
}).strict();
export type ReplayDeliveryStatus = z.infer<typeof ReplayDeliveryStatusSchema>;

export const ReplayProjectionSchema = z.object({
  replay_id: ReplayIdSchema,
  request_hash: CanonicalRequestHashSchema,
  source: z.string().min(1),
  terminal: z.boolean(),
  events: z.array(ReplayEventRecordSchema),
  deliveries: z.array(ReplayDeliveryStatusSchema),
}).strict();
export type ReplayProjection = z.infer<typeof ReplayProjectionSchema>;
