import { describe, expect, test } from "bun:test";
import { BindState, BIND_STATES, classifyBind } from "../src/bind.ts";
import type { WrapperLedgerRowT } from "../src/ledger.ts";

function row(overrides: Partial<WrapperLedgerRowT> = {}): WrapperLedgerRowT {
  return {
    wrapper_id: "wl",
    instance_id: "inst-1",
    persona: "council:custodes",
    pane_positional_id: "council:custodes",
    engine: "claude",
    working_dir: "/x",
    born_epoch: 1_752_600_000,
    state: "OPEN",
    ...overrides,
  };
}

describe("bind lifecycle (foundation)", () => {
  test("the four states are registered | bound | late-bind | never-bind", () => {
    expect([...BIND_STATES].sort()).toEqual(["bound", "late-bind", "never-bind", "registered"]);
    expect(BindState.parse("late-bind")).toBe("late-bind");
    expect(() => BindState.parse("half-bound")).toThrow();
  });

  test("bound: instance row + stamp + ledger row carrying the instance_id", () => {
    expect(
      classifyBind({ has_instance_row: true, instance_stamp: "inst-1", ledger_row: row() }),
    ).toBe("bound");
  });

  test("registered: instance row exists but no pane stamp and no ledger row yet", () => {
    expect(
      classifyBind({ has_instance_row: true, instance_stamp: "", ledger_row: null }),
    ).toBe("registered");
  });

  // Two live late-bind pathways observed 2026-07-16 (reconstructed from mechanism):
  test("late-bind A: ledger row exists but instance_id empty, stamp not yet written", () => {
    expect(
      classifyBind({
        has_instance_row: true,
        instance_stamp: "",
        ledger_row: row({ instance_id: "" }),
      }),
    ).toBe("late-bind");
  });

  test("late-bind B: stamp present but ledger row still carries empty instance_id", () => {
    expect(
      classifyBind({
        has_instance_row: true,
        instance_stamp: "inst-1",
        ledger_row: row({ instance_id: "" }),
      }),
    ).toBe("late-bind");
  });

  test("never-bind: live via stamp, no ledger row at all (the codex gap)", () => {
    expect(
      classifyBind({ has_instance_row: true, instance_stamp: "inst-9", ledger_row: null }),
    ).toBe("never-bind");
  });
});
