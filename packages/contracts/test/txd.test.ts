import { describe, expect, test } from "bun:test";
import {
  ACT_EVENT_NAMES,
  EVENT_TYPES,
  EventInputSchema,
  EventTypeSchema,
  HealthSchema,
  REG_EVENT_NAMES,
  SCHEMA_VERSION,
  SendReceiptSchema,
  eventDomain,
} from "../src/txd.ts";

// The txd lifecycle vocabulary is CLOSED: these pins are the drift alarm.

describe("txd lifecycle vocabulary", () => {
  test("schema_version pins at 4 (v4 = frozen-send cancellation)", () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  test("the qualified event-type union is exactly the ruled 19 (11 reg + 8 act)", () => {
    expect(EVENT_TYPES).toHaveLength(19);
    expect(REG_EVENT_NAMES).toHaveLength(11);
    expect(ACT_EVENT_NAMES).toHaveLength(8);
    for (const t of EVENT_TYPES) {
      const domain = eventDomain(t);
      const name = t.slice(t.indexOf(".") + 1);
      expect(["reg", "act"]).toContain(domain);
      const names: readonly string[] = domain === "reg" ? REG_EVENT_NAMES : ACT_EVENT_NAMES;
      expect(names).toContain(name);
    }
    expect(() => EventTypeSchema.parse("reg.invented_event")).toThrow();
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

  test("partial_delivered must carry non-null byte evidence (refine enforced)", () => {
    const base = {
      verdict: "partial_delivered",
      resolution: { target: "somnium:NE", seat_id: "somnium:NE", bound_seq: 0 },
      gate_reason: null,
      cancellation_reason: null,
      activity_window_ms: null,
      send_seq: 1,
    };
    expect(() => SendReceiptSchema.parse({ ...base, bytes_delivered: null })).toThrow();
    expect(SendReceiptSchema.parse({ ...base, bytes_delivered: 3 }).bytes_delivered).toBe(3);
  });

  test("cancelled receipts name only the binding generation reason", () => {
    expect(SendReceiptSchema.parse({
      verdict: "cancelled",
      resolution: { target: "somnium:NE", seat_id: "somnium:NE", bound_seq: 42 },
      gate_reason: null,
      cancellation_reason: "binding_changed",
      activity_window_ms: null,
      bytes_delivered: 0,
      send_seq: 9,
    }).verdict).toBe("cancelled");
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
    };
    expect(HealthSchema.parse(health).service).toBe("txd");
    expect(() => HealthSchema.parse({ ...health, service: "k12_daemon" })).toThrow();
  });
});
