import { describe, expect, test } from "bun:test";
import {
  ACT_EVENT_NAMES,
  CLOSE_REQUIRED_RANK,
  CloseRequestSchema,
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
  test("schema_version pins at 11 (lifecycle correlation leaves txd; plan approval gains its intent)", () => {
    expect(SCHEMA_VERSION).toBe(11);
  });

  test("the qualified event-type union includes communication and estate lifecycle facts", () => {
    expect(EVENT_TYPES).toHaveLength(41);
    expect(EVENT_TYPES).toContain('act.agent_input_injected');
    expect(EVENT_TYPES).toContain('reg.comm_accepted');
    expect(EVENT_TYPES).toContain('reg.placement_attested');
    expect(EVENT_TYPES).toContain('act.comm_callback_asserted');
    expect(EVENT_TYPES).toContain('act.comm_redrive_attempted');
    expect(EVENT_TYPES).toContain('act.comm_delivery_failed');
    expect(EVENT_TYPES).toContain('act.comm_watch_unarmed');
    expect(EVENT_TYPES).toContain('act.mode_transition_requested');
    expect(EVENT_TYPES).toContain('act.mode_transition_attested');
    expect(EVENT_TYPES).toContain('act.mode_transition_failed');
    expect(REG_EVENT_NAMES).toHaveLength(19);
    expect(ACT_EVENT_NAMES).toHaveLength(13);
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
      schema_version: 11,
      target: "council:custodes",
      intent: "enter_plan",
      trigger: "preplan",
    })).toEqual({
      schema_version: 11,
      target: "council:custodes",
      intent: "enter_plan",
      trigger: "preplan",
    });
    expect(() => ModeTransitionRequestSchema.parse({
      schema_version: 11,
      target: "council:custodes",
      intent: "send_keys",
      trigger: "operator",
    })).toThrow();
    for (const raw of [
      { pane_id: "%13" },
      { keys: ["BTab"] },
    ]) {
      expect(() => ModeTransitionRequestSchema.parse({
        schema_version: 11,
        target: "council:custodes",
        intent: "enter_plan",
        trigger: "preplan",
        ...raw,
      })).toThrow();
    }
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
    expect(TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-exited', page: 'palace' })).toEqual({
      schema_version: 11, event: 'pane-exited', page: 'palace',
    });
    expect(() => TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-vanished', page: 'palace' })).toThrow();
  });

  test('pane-killed is the page-less kill-time event: tmux cannot name the page a kill emptied', () => {
    expect(TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-killed' })).toEqual({
      schema_version: 11, event: 'pane-killed',
    });
    // A kill-time page claim is untrustworthy (hook context is the active
    // window) and a process-death event without its page is unscoped: both
    // shapes are refused, not silently accommodated.
    expect(() => TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-killed', page: 'palace' })).toThrow();
    expect(() => TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-died' })).toThrow();
    expect(() => TmuxLifecycleEventRequestSchema.parse({ schema_version: 11, event: 'pane-exited' })).toThrow();
  });

  test("comm payload boundary is UTF-8 byte exact and format agnostic", () => {
    const base = { schema_version: 11, source_agent_id: "source", target: "target", ask: false, reply: false };
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
      tints: [],
    };
    expect(HealthSchema.parse(health).service).toBe("txd");
    expect(() => HealthSchema.parse({ ...health, service: "k12_daemon" })).toThrow();
  });

  test("close requires exactly one selector and pins the overseer rank", () => {
    expect(CLOSE_REQUIRED_RANK).toBe('overseer');
    const base = { schema_version: 11, source_agent_id: 'ov-1' };
    expect(CloseRequestSchema.parse({ ...base, targets: ['reservists:W', 'w-2'], force: true }).targets).toHaveLength(2);
    expect(CloseRequestSchema.parse({ ...base, page: 'reservists' }).page).toBe('reservists');
    expect(CloseRequestSchema.parse({ ...base, all_idle: true }).all_idle).toBe(true);
    // Selector discipline: none, two, or an empty list are refused shapes.
    expect(() => CloseRequestSchema.parse(base)).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, targets: [] })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, targets: ['a'], page: 'reservists' })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, page: 'reservists', all_idle: true })).toThrow();
    // Filters are inherently graceful: force never combines with them.
    expect(() => CloseRequestSchema.parse({ ...base, page: 'reservists', force: true })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, all_idle: true, force: true })).toThrow();
    // The caller is named, always.
    expect(() => CloseRequestSchema.parse({ schema_version: 11, targets: ['a'] })).toThrow();
  });
});
