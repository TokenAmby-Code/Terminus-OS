import { describe, expect, test } from "bun:test";
import {
  LifecycleObservation,
  NotificationIngress,
  NOTIFICATION_CONTRACT_VERSION,
  PERSONAL_NOTIFICATION_PROFILE,
  resolveNotificationRoute,
  WORK_NOTIFICATION_PROFILE,
} from "@terminus-os/contracts";
import {
  NotificationIngress as SubpathNotificationIngress,
  NOTIFICATION_CONTRACT_VERSION as SUBPATH_VERSION,
} from "@terminus-os/contracts/notification";

const agent = {
  version: "notification-origin.v1",
  origin: { machine: "k12-personal", domain: "personal" },
  notification_class: "agent",
  event: { id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c77", kind: "agent_stop" },
  priority: "normal",
  content_reference: {
    kind: "agent_lifecycle",
    id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c78",
  },
} as const;

describe("notification-origin.v1 behavioral pins", () => {
  test("the package root and ./notification subpath expose the canonical contract", () => {
    expect(SubpathNotificationIngress).toBe(NotificationIngress);
    expect(SUBPATH_VERSION).toBe(NOTIFICATION_CONTRACT_VERSION);
  });

  test("machine provenance derives the local identity and logical destination", () => {
    expect(resolveNotificationRoute(PERSONAL_NOTIFICATION_PROFILE, agent)).toEqual({
      version: NOTIFICATION_CONTRACT_VERSION,
      domain: "personal",
      identity: "agent",
      destination: "agent_output",
    });

    const work = {
      ...agent,
      origin: { machine: "k12-work", domain: "work" },
    };
    expect(resolveNotificationRoute(WORK_NOTIFICATION_PROFILE, work)).toEqual({
      version: NOTIFICATION_CONTRACT_VERSION,
      domain: "work",
      identity: "agent",
      destination: "agent_output",
    });
  });

  test("cross-domain routing fails closed", () => {
    expect(() => resolveNotificationRoute(PERSONAL_NOTIFICATION_PROFILE, {
      ...agent,
      origin: { machine: "k12-work", domain: "work" },
    })).toThrow("does not match local profile");
    expect(() => resolveNotificationRoute(WORK_NOTIFICATION_PROFILE, agent)).toThrow(
      "does not match local profile",
    );
  });

  test("provenance is required and must be internally consistent", () => {
    expect(() => NotificationIngress.parse({ ...agent, origin: undefined })).toThrow();
    expect(() => NotificationIngress.parse({
      ...agent,
      origin: { machine: "k12-personal", domain: "work" },
    })).toThrow();
  });

  test("callers cannot supply credentials or literal destinations", () => {
    for (const forbidden of ["token", "guild_id", "channel_id", "channel", "destination"] as const) {
      expect(() => NotificationIngress.parse({ ...agent, [forbidden]: "secret-or-id" })).toThrow();
    }
    expect(JSON.stringify(PERSONAL_NOTIFICATION_PROFILE)).not.toMatch(/token|guild|channel/i);
    expect(JSON.stringify(WORK_NOTIFICATION_PROFILE)).not.toMatch(/token|guild|channel/i);
  });

  test("agent stop hooks cannot classify as Administratum", () => {
    expect(() => NotificationIngress.parse({
      ...agent,
      notification_class: "administratum",
      content_reference: {
        kind: "operational_metadata",
        id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c78",
      },
    })).toThrow();
  });

  test("Administratum accepts metadata references, never agent output", () => {
    const admin = {
      ...agent,
      notification_class: "administratum",
      event: { ...agent.event, kind: "health_changed" },
      content_reference: {
        kind: "operational_metadata",
        id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c78",
      },
    };
    expect(resolveNotificationRoute(PERSONAL_NOTIFICATION_PROFILE, admin).destination).toBe(
      "administratum_output",
    );
    expect(() => NotificationIngress.parse({
      ...admin,
      content_reference: { ...agent.content_reference, kind: "agent_output" },
    })).toThrow();
  });

  test("work content and secret-shaped payload fields are rejected at ingress", () => {
    for (const forbidden of [
      "prompt", "output", "session_document", "transcript", "task_body", "customer_data",
      "generated_content", "secret", "api_key",
    ] as const) {
      expect(() => NotificationIngress.parse({ ...agent, [forbidden]: "work content" })).toThrow();
    }
  });

  test("sanitized lifecycle observation is a separate strict allowlist", () => {
    const observation = {
      version: "notification-origin.v1",
      event_id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c77",
      origin: { machine: "k12-work", domain: "work" },
      observed_at: "2026-07-17T18:00:00.000Z",
      fact: { kind: "pr_merged", repository: "Terminus-OS", pull_request: 3 },
    } as const;
    expect(LifecycleObservation.parse(observation)).toEqual(observation);
    expect(() => LifecycleObservation.parse({ ...observation, agent_output: "done" })).toThrow();
    expect(() => LifecycleObservation.parse({
      ...observation,
      fact: { ...observation.fact, prompt: "private" },
    })).toThrow();
  });
});
