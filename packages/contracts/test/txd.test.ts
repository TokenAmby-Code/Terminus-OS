import { describe, expect, test } from "bun:test";
import {
  ACT_EVENT_NAMES,
  CommRequestSchema,
  EVENT_TYPES,
  ESTATE_EVENT_NAMES,
  EventInputSchema,
  EventTypeSchema,
  HealthSchema,
  MAX_COMM_MESSAGE_BYTES,
  ModeTransitionRequestSchema,
  REG_EVENT_NAMES,
  SCHEMA_VERSION,
  TmuxLifecycleEventRequestSchema,
  eventDomain,
} from "../src/txd.ts";

// The txd lifecycle vocabulary is CLOSED: these pins are the drift alarm.

describe("txd lifecycle vocabulary", () => {
  test("schema_version pins at 9 (v9 = typed plan-mode transitions)", () => {
    expect(SCHEMA_VERSION).toBe(9);
  });

  test("the qualified event-type union includes communication and estate lifecycle facts", () => {
    expect(EVENT_TYPES).toHaveLength(36);
    expect(EVENT_TYPES).toContain('reg.comm_accepted');
    expect(EVENT_TYPES).toContain('act.comm_callback_asserted');
    expect(EVENT_TYPES).toContain('act.mode_transition_requested');
    expect(EVENT_TYPES).toContain('act.mode_transition_attested');
    expect(EVENT_TYPES).toContain('act.mode_transition_failed');
    expect(REG_EVENT_NAMES).toHaveLength(18);
    expect(ACT_EVENT_NAMES).toHaveLength(9);
    expect(ESTATE_EVENT_NAMES).toEqual([
      'rotation_refused', 'rotation_requested', 'rotation_completed',
      'scoped_reset_refused', 'scoped_reset_requested', 'scoped_reset_completed', 'scoped_reset_failed',
      'topology_migration_requested', 'topology_migration_completed',
    ]);
    for (const t of EVENT_TYPES) {
      const domain = eventDomain(t);
      const name = t.slice(t.indexOf(".") + 1);
      expect(["reg", "act", "estate"]).toContain(domain);
      const names: readonly string[] = domain === "reg" ? REG_EVENT_NAMES : domain === "act" ? ACT_EVENT_NAMES : ESTATE_EVENT_NAMES;
      expect(names).toContain(name);
    }
    expect(() => EventTypeSchema.parse("reg.invented_event")).toThrow();
  });

  test("mode transition input is semantic and logical, never raw tmux input", () => {
    expect(ModeTransitionRequestSchema.parse({
      schema_version: 9,
      target: "council:custodes",
      intent: "enter_plan",
      trigger: "preplan",
    })).toEqual({
      schema_version: 9,
      target: "council:custodes",
      intent: "enter_plan",
      trigger: "preplan",
    });
    expect(() => ModeTransitionRequestSchema.parse({
      schema_version: 9,
      target: "council:custodes",
      intent: "send_keys",
      trigger: "operator",
    })).toThrow();
  });

  test("event input holds dumb facts only — the 6 pre-store columns", () => {
    const parsed = EventInputSchema.parse({
      entity_type: "seat",
      entity_id: "somnium:NE",
      event_type: "reg.pane_created",
      payload: { pane_state: "live" },
      provenance: { source: "observer", transport_receipt: null, emitter_version: SCHEMA_VERSION },
      occurred_at: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.event_type).toBe("reg.pane_created");
  });

  test('tmux lifecycle ingress accepts only typed pane events with canonical page input', () => {
    expect(TmuxLifecycleEventRequestSchema.parse({ schema_version: 9, event: 'pane-exited', page: 'palace' })).toEqual({
      schema_version: 9, event: 'pane-exited', page: 'palace',
    });
    expect(() => TmuxLifecycleEventRequestSchema.parse({ schema_version: 9, event: 'pane-vanished', page: 'palace' })).toThrow();
  });

  test("comm payload boundary is UTF-8 byte exact and format agnostic", () => {
    const base = { schema_version: 9, source_instance_id: "source", target: "target", ask: false, reply: false };
    expect(CommRequestSchema.parse({ ...base, message: "x".repeat(MAX_COMM_MESSAGE_BYTES) }).message.length).toBe(MAX_COMM_MESSAGE_BYTES);
    expect(() => CommRequestSchema.parse({ ...base, message: "λ".repeat(MAX_COMM_MESSAGE_BYTES / 2 + 1) })).toThrow();
    expect(CommRequestSchema.parse({ ...base, message: "---\na: 1\n---\n{\"quoted\":true}" }).message).toContain('quoted');
  });

  test("health names the service txd — nothing k12-named survives of the daemon", () => {
    const health = {
      ok: true,
      service: "txd",
      schema_version: SCHEMA_VERSION,
      version: "0.1.0",
      git_sha: "deadbeef",
      bun: "1.3.14",
      machine: "k12-personal",
      events: 0,
      open_contradictions: 0,
      tmux_reachable: true,
      static_personas: [],
      tints: [],
    };
    expect(HealthSchema.parse(health).service).toBe("txd");
    expect(() => HealthSchema.parse({ ...health, service: "k12_daemon" })).toThrow();
  });
});
