import { describe, expect, test } from "bun:test";
import {
  InstanceRegistrationRow,
  INSTANCE_STATUSES,
  ORIGIN_TYPES,
  RankId,
} from "../src/registration.ts";

// Mirror of the identity/lifecycle core of the `instances` table
// The contract pins the canonical instance registration row.
const ROW = {
  id: "inst-abc",
  name: "terminus-os-scaffold",
  engine: "claude",
  working_dir: "/Users/tokenclaw/worktrees/Terminus-OS/main",
  device_id: "k12-personal",
  origin_type: "dispatch",
  commander_type: "persona",
  commander_id: "council:custodes",
  status: "working",
  created_at: "2026-07-16 21:00:00",
  last_activity: "2026-07-16 21:05:00",
  stopped_at: null,
  archived_at: null,
  persona_id: "council:custodes",
  rank: "astartes",
  session_doc_id: 42,
  continuity_binding_source: null,
  wrapper_launch_id: "wl-001",
  automated: false,
  notification_mode: "verbose",
  interaction_mode: "text",
  is_subagent: false,
  hook_driven: false,
  stop_allowed: true,
} as const;

describe("instance registration row (foundation)", () => {
  test("a representative registration row parses", () => {
    const row = InstanceRegistrationRow.parse(ROW);
    expect(row.id).toBe("inst-abc");
    expect(row.wrapper_launch_id).toBe("wl-001");
  });

  test("enums are enforced faithfully to the DB CHECK constraints", () => {
    expect(ORIGIN_TYPES).toContain("perpetual");
    expect(INSTANCE_STATUSES).toContain("victorious");
    expect(() => InstanceRegistrationRow.parse({ ...ROW, origin_type: "telepathy" })).toThrow();
    expect(() => InstanceRegistrationRow.parse({ ...ROW, status: "vibing" })).toThrow();
  });

  test("rank accepts the fixed ranks OR an aspirant:* label", () => {
    expect(RankId.parse("primarch")).toBe("primarch");
    expect(RankId.parse("aspirant:ultramarines")).toBe("aspirant:ultramarines");
    expect(() => RankId.parse("aspirant")).toThrow();
    expect(() => RankId.parse("chaplain")).toThrow();
  });

  test("lifecycle flags are strict booleans (integers and strings rejected)", () => {
    expect(() => InstanceRegistrationRow.parse({ ...ROW, automated: 1 })).toThrow();
    expect(() => InstanceRegistrationRow.parse({ ...ROW, automated: "true" })).toThrow();
  });
});
