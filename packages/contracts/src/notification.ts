import { z } from "zod";

/** Stable consumer contract for notification ingress, routing, and sanitized observation. */
export const NOTIFICATION_CONTRACT_VERSION = "notification-origin.v1" as const;

export const NotificationPriority = z.enum(["low", "normal", "high", "urgent"]);
export type NotificationPriorityT = z.infer<typeof NotificationPriority>;

/** Machine and domain are one provenance fact, not independently selectable fields. */
export const NotificationOrigin = z.discriminatedUnion("machine", [
  z.strictObject({ machine: z.literal("k12-personal"), domain: z.literal("personal") }),
  z.strictObject({ machine: z.literal("k12-work"), domain: z.literal("work") }),
]);
export type NotificationOriginT = z.infer<typeof NotificationOrigin>;

const EventIdentity = z.strictObject({
  id: z.uuid(),
  kind: z.string().min(1),
});

const ContentReferenceIdentity = z.strictObject({
  id: z.uuid(),
});

const AgentNotification = z.strictObject({
  version: z.literal(NOTIFICATION_CONTRACT_VERSION),
  origin: NotificationOrigin,
  notification_class: z.literal("agent"),
  event: EventIdentity.extend({
    kind: z.enum(["agent_started", "agent_progress", "agent_stop", "agent_failed"]),
  }),
  priority: NotificationPriority,
  content_reference: ContentReferenceIdentity.extend({
    kind: z.enum(["agent_lifecycle", "agent_output"]),
  }),
});

const AdministratumNotification = z.strictObject({
  version: z.literal(NOTIFICATION_CONTRACT_VERSION),
  origin: NotificationOrigin,
  notification_class: z.literal("administratum"),
  event: EventIdentity.extend({
    kind: z.enum([
      "instance_started",
      "instance_stopped",
      "health_changed",
      "delivery_succeeded",
      "delivery_failed",
      "pr_merged",
    ]),
  }),
  priority: NotificationPriority,
  content_reference: ContentReferenceIdentity.extend({
    kind: z.literal("operational_metadata"),
  }),
});

/**
 * Notification ingress contains identity and references only. It deliberately has no content,
 * credential, guild, channel, route, or destination field. Strict parsing rejects all of them.
 */
export const NotificationIngress = z.discriminatedUnion("notification_class", [
  AgentNotification,
  AdministratumNotification,
]);
export type NotificationIngressT = z.infer<typeof NotificationIngress>;

export const NotificationProfile = z.discriminatedUnion("machine", [
  z.strictObject({ machine: z.literal("k12-personal"), domain: z.literal("personal") }),
  z.strictObject({ machine: z.literal("k12-work"), domain: z.literal("work") }),
]);
export type NotificationProfileT = z.infer<typeof NotificationProfile>;

/** Credential-free fixtures consumed identically by both host profiles. */
export const PERSONAL_NOTIFICATION_PROFILE = {
  machine: "k12-personal",
  domain: "personal",
} as const satisfies NotificationProfileT;
export const WORK_NOTIFICATION_PROFILE = {
  machine: "k12-work",
  domain: "work",
} as const satisfies NotificationProfileT;

export const NotificationRoute = z.strictObject({
  version: z.literal(NOTIFICATION_CONTRACT_VERSION),
  domain: z.enum(["personal", "work"]),
  identity: z.enum(["agent", "administratum"]),
  destination: z.enum(["agent_output", "administratum_output"]),
});
export type NotificationRouteT = z.infer<typeof NotificationRoute>;

/** Resolve only a logical, machine-local destination. Literal Discord state stays downstream. */
export function resolveNotificationRoute(
  localProfile: NotificationProfileT,
  input: unknown,
): NotificationRouteT {
  const profile = NotificationProfile.parse(localProfile);
  const notification = NotificationIngress.parse(input);
  if (
    notification.origin.machine !== profile.machine ||
    notification.origin.domain !== profile.domain
  ) {
    throw new Error("notification origin does not match local profile");
  }

  return {
    version: NOTIFICATION_CONTRACT_VERSION,
    domain: profile.domain,
    identity: notification.notification_class,
    destination:
      notification.notification_class === "agent" ? "agent_output" : "administratum_output",
  };
}

const ObservationBase = {
  version: z.literal(NOTIFICATION_CONTRACT_VERSION),
  event_id: z.uuid(),
  origin: NotificationOrigin,
  observed_at: z.iso.datetime(),
};

const SimpleObservationKind = z.enum([
  "instance_started",
  "instance_stopped",
  "health_changed",
  "delivery_succeeded",
  "delivery_failed",
]);

const SimpleObservation = z.strictObject({
  ...ObservationBase,
  fact: z.strictObject({ kind: SimpleObservationKind }),
});

const PullRequestObservation = z.strictObject({
  ...ObservationBase,
  fact: z.strictObject({
    kind: z.literal("pr_merged"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    pull_request: z.number().int().positive(),
  }),
});

/**
 * Sanitized durable observation is intentionally separate from delivery. Its fact variants are
 * a closed operational-metadata allowlist and have no agent-output or arbitrary-content slot.
 */
export const LifecycleObservation = z.union([SimpleObservation, PullRequestObservation]);
export type LifecycleObservationT = z.infer<typeof LifecycleObservation>;
