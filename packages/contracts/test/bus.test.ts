import { describe, expect, test } from "bun:test";
import {
  BUS_SCHEMA_VERSION,
  BusCursorAdvanceRequestSchema,
  BusCursorAdvanceResponseSchema,
  BusDeliverySchema,
  BusEventRecordSchema,
  BusEventTypeSchema,
  BusLagRowSchema,
  BusPublishRequestSchema,
  BusSubscriptionRowSchema,
} from "../src/bus.ts";

const record = {
  seq: 42,
  event_type: "hook.stop",
  source: "claude",
  payload: { agent_id: "i1", schema_version: 6 },
  provenance: { ingress: "hooks", transport_receipt: "edge_proxy", machine: "k12-personal" },
  occurred_at: "2026-07-22T00:00:00.000Z",
  recorded_at: "2026-07-22T00:00:00.100Z",
} as const;

describe("bus event vocabulary", () => {
  test("administrative cursor advance names the exact current cursor, cutoff, and matching dead set", () => {
    const request = {
      schema_version: BUS_SCHEMA_VERSION as 1,
      subscription: "registrationd-k12-personal-agent-lifecycle",
      expected_acked_seq: 88686,
      through_seq: 109053,
      expected_matching_seqs: [108827, 108917, 108930, 108944, 109018, 109053],
      reason: "schema-1 lifecycle generation retired by Emperor ruling",
    };
    expect(BusCursorAdvanceRequestSchema.parse(request)).toEqual(request);
    expect(() => BusCursorAdvanceRequestSchema.parse({ ...request, expected_matching_seqs: [108917, 108827] })).toThrow();
    expect(() => BusCursorAdvanceRequestSchema.parse({ ...request, through_seq: 109054 })).toThrow();
    expect(() => BusCursorAdvanceRequestSchema.parse({ ...request, reason: "" })).toThrow();
    expect(BusCursorAdvanceResponseSchema.parse({
      ok: true,
      subscription: request.subscription,
      previous_acked_seq: request.expected_acked_seq,
      acked_seq: request.through_seq,
      skipped_matching_seqs: request.expected_matching_seqs,
      audit_seq: 111908,
    }).audit_seq).toBe(111908);
  });

  test("event_type is dotted lowercase — an unqualified name carries no tenant", () => {
    expect(BusEventTypeSchema.parse("hook.stop")).toBe("hook.stop");
    expect(BusEventTypeSchema.parse("txd.act.stop_reported")).toBe("txd.act.stop_reported");
    for (const bad of ["stop", "Hook.Stop", "hook.", ".stop", "hook..stop", "hook.stop!", "hook stop"]) {
      expect(() => BusEventTypeSchema.parse(bad)).toThrow();
    }
  });

  test("a journal record round-trips exactly; provenance names its ingress door", () => {
    expect(BusEventRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      BusEventRecordSchema.parse({
        ...record,
        provenance: { ...record.provenance, ingress: "smuggled" },
      }),
    ).toThrow();
  });

  test("the generic publish door rejects the reserved hook.* prefix by construction", () => {
    const publish = {
      schema_version: BUS_SCHEMA_VERSION,
      event_type: "obsidian.note_ingested",
      source: "obsidian-ingress",
      payload: { path: "daily/2026-07-22.md" },
      occurred_at: "2026-07-22T00:00:00.000Z",
    };
    expect(BusPublishRequestSchema.parse(publish).event_type).toBe("obsidian.note_ingested");
    expect(() =>
      BusPublishRequestSchema.parse({ ...publish, event_type: "hook.stop" }),
    ).toThrow(/reserved/);
  });

  test("a delivery is one full journal row under the pinned envelope", () => {
    const delivery = { schema_version: BUS_SCHEMA_VERSION, subscription: "txd", event: record };
    expect(BusDeliverySchema.parse(delivery)).toEqual(delivery);
    expect(() => BusDeliverySchema.parse({ ...delivery, event: { ...record, seq: "42" } })).toThrow();
  });

  test("subscription rows pin a real delivery URL; lag rows surface an unseeded cursor as null", () => {
    expect(
      BusSubscriptionRowSchema.parse({
        name: "txd",
        delivery_url: "http://127.0.0.1:7781/ingress/bus",
        event_pattern: "hook.%",
        active: true,
      }).name,
    ).toBe("txd");
    expect(
      BusSubscriptionRowSchema.parse({
        name: "githubd-github",
        delivery_url: "http+unix://%2Frun%2Fgithubd%2Fghd.sock/event",
        event_pattern: "github.%",
        active: true,
      }).delivery_url,
    ).toBe("http+unix://%2Frun%2Fgithubd%2Fghd.sock/event");
    expect(() =>
      BusSubscriptionRowSchema.parse({
        name: "txd",
        delivery_url: "not a url",
        event_pattern: "hook.%",
        active: true,
      }),
    ).toThrow();
    expect(
      BusLagRowSchema.parse({ name: "probe", active: true, event_pattern: "hook.%", acked_seq: null, lag: 3 }).acked_seq,
    ).toBeNull();
  });
});
