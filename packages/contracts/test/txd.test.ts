import { describe, expect, test } from "bun:test";
import {
  ACT_EVENT_NAMES,
  CLOSE_REQUIRED_RANK,
  CloseRequestSchema,
  COMM_DELIVERY_RECEIPT_TIMEOUT_MS,
  CommReceiptSchema,
  CommReceiptWaitRequestSchema,
  CommRequestSchema,
  EVENT_TYPES,
  ESTATE_EVENT_NAMES,
  EventInputSchema,
  EventTypeSchema,
  HealthSchema,
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
    expect(EVENT_TYPES).toHaveLength(42);
    expect(EVENT_TYPES).toContain('act.agent_input_injected');
    expect(EVENT_TYPES).toContain('reg.comm_accepted');
    expect(EVENT_TYPES).toContain('reg.placement_attested');
    expect(EVENT_TYPES).toContain('act.comm_callback_asserted');
    expect(EVENT_TYPES).toContain('act.comm_redrive_attempted');
    expect(EVENT_TYPES).toContain('act.comm_delivery_failed');
    expect(EVENT_TYPES).toContain('act.comm_delivery_confirmation_dead_lettered');
    expect(EVENT_TYPES).toContain('act.comm_watch_unarmed');
    expect(EVENT_TYPES).toContain('reg.composer_observation_prepared');
    expect(EVENT_TYPES).toContain('act.composer_interactive_announced');
    expect(EVENT_TYPES).toContain('act.mode_transition_requested');
    expect(EVENT_TYPES).toContain('act.mode_transition_attested');
    expect(EVENT_TYPES).toContain('act.mode_transition_failed');
    expect(REG_EVENT_NAMES).toHaveLength(20);
    expect(ACT_EVENT_NAMES).toHaveLength(15);
    expect(ESTATE_EVENT_NAMES).toEqual([
      'rotation_refused', 'rotation_requested', 'rotation_completed',
      'scoped_reset_refused', 'scoped_reset_requested', 'scoped_reset_completed', 'scoped_reset_failed',
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

  test("behavioral pin: comm payloads are opaque and have no caller-visible length boundary", () => {
    const base = { schema_version: 11, source_agent_id: "source", target: "target", ask: false, reply: false };
    const large = `start\n${"λ quoted='yes' 🛡️\n".repeat(16_384)}end`;
    expect(CommRequestSchema.parse({ ...base, message: large }).message).toBe(large);
    expect(CommRequestSchema.parse({ ...base, message: "---\na: 1\n---\n{\"quoted\":true}" }).message).toContain('quoted');
  });

  test("behavioral pin: comm intent is exactly one engine-neutral command or skill", () => {
    const base = { schema_version: 11, source_agent_id: "source", target: "target", ask: false, reply: false };
    expect(CommRequestSchema.parse({ ...base, intent: { kind: "command", name: "compact", args: ["hard"] } }).intent)
      .toEqual({ kind: "command", name: "compact", args: ["hard"] });
    expect(CommRequestSchema.parse({ ...base, intent: { kind: "skill", name: "openai-docs", args: [] } }).intent)
      .toEqual({ kind: "skill", name: "openai-docs", args: [] });
    expect(() => CommRequestSchema.parse({ ...base, message: "hello", intent: { kind: "command", name: "compact", args: [] } })).toThrow();
    for (const name of ["/compact", "$openai-docs", "two words", ""]) {
      expect(() => CommRequestSchema.parse({ ...base, intent: { kind: "skill", name, args: [] } })).toThrow();
    }
    expect(() => CommRequestSchema.parse({ ...base, intent: { kind: "skill", name: "openai-docs", args: [], engine: "codex" } })).toThrow();
    expect(() => CommRequestSchema.parse({ ...base, intent: { kind: "skill", name: "openai-docs", args: [] }, engine: "codex" })).toThrow();
  });

  test("behavioral pin: comm receipt wait has a fixed ceiling, two success tiers, and a typed refusal", () => {
    expect(COMM_DELIVERY_RECEIPT_TIMEOUT_MS).toBe(30_000);
    expect(CommReceiptWaitRequestSchema.parse({
      schema_version: 11,
      message_id: "message-1",
      source_agent_id: "source",
    })).toEqual({ schema_version: 11, message_id: "message-1", source_agent_id: "source" });
    expect(() => CommReceiptWaitRequestSchema.parse({
      schema_version: 11,
      message_id: "message-1",
      source_agent_id: "source",
      timeout_ms: 1,
    })).toThrow();
    expect(CommReceiptSchema.parse({
      ok: true,
      schema_version: 11,
      phase: "delivery_confirmed",
      message_id: "message-1",
      source_agent_id: "source",
      deliveries: [{
        target: { agent_id: "target", seat_id: "palace:W", persona: null },
        delivered: true,
        asserted_at: "2026-08-15T17:00:01.000Z",
        assertion_event_id: 42,
      }],
    }).phase).toBe("delivery_confirmed");
    expect(CommReceiptSchema.parse({
      ok: true,
      schema_version: 11,
      phase: "bytes_sent",
      message_id: "message-2",
      source_agent_id: "source",
      targets: [{ agent_id: "target", seat_id: "palace:W", persona: null }],
      bytes_sent: 5,
      staged: true,
      event_ids: [41],
    }).phase).toBe("bytes_sent");
    const refused = {
      ok: false,
      schema_version: 11,
      phase: "transport_refused",
      message_id: "message-3",
      source_agent_id: "source",
      targets: [{ agent_id: "target", seat_id: "palace:W", persona: null }],
      bytes_sent: 0,
      submit_verdict: "composer_corrupted",
      refusals: [{
        target: { agent_id: "target", seat_id: "palace:W", persona: null },
        bytes: 0,
        submit_verdict: "composer_corrupted",
        event_id: 43,
      }],
      event_ids: [43],
    } as const;
    expect(CommReceiptSchema.parse(refused).phase).toBe("transport_refused");
    expect(() => CommReceiptSchema.parse({ ...refused, refusals: [] })).toThrow();
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
      estate_generation: "canonical",
      activation_pending: false,
      tints: [],
    };
    expect(HealthSchema.parse(health).service).toBe("txd");
    expect(HealthSchema.parse(health).activation_pending).toBe(false);
    expect(() => HealthSchema.parse({ ...health, service: "k12_daemon" })).toThrow();
  });

  test("close requires exactly one selector and pins the overseer rank", () => {
    expect(CLOSE_REQUIRED_RANK).toBe('overseer');
    const base = { schema_version: 11, source_agent_id: 'ov-1' };
    expect(CloseRequestSchema.parse({ ...base, targets: ['palace:W', 'w-2'], force: true }).targets).toHaveLength(2);
    expect(CloseRequestSchema.parse({ ...base, page: 'palace' }).page).toBe('palace');
    expect(CloseRequestSchema.parse({ ...base, all_idle: true }).all_idle).toBe(true);
    // Selector discipline: none, two, or an empty list are refused shapes.
    expect(() => CloseRequestSchema.parse(base)).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, targets: [] })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, targets: ['a'], page: 'palace' })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, page: 'palace', all_idle: true })).toThrow();
    // Filters are inherently graceful: force never combines with them.
    expect(() => CloseRequestSchema.parse({ ...base, page: 'palace', force: true })).toThrow();
    expect(() => CloseRequestSchema.parse({ ...base, all_idle: true, force: true })).toThrow();
    // The caller is named, always.
    expect(() => CloseRequestSchema.parse({ schema_version: 11, targets: ['a'] })).toThrow();
  });
});
