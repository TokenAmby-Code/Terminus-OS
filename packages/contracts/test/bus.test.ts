import { describe, expect, test } from "bun:test";
import {
  BUS_SCHEMA_VERSION,
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
  payload: { instance_id: "i1", schema_version: 6 },
  provenance: { ingress: "hooks", transport_receipt: "edge_proxy", machine: "k12-personal" },
  occurred_at: "2026-07-22T00:00:00.000Z",
  recorded_at: "2026-07-22T00:00:00.100Z",
} as const;

describe("bus event vocabulary", () => {
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
