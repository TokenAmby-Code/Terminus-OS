import { describe, expect, test } from "bun:test";
import {
  ACTIVE_OCCUPANCY_STATES,
  isActiveOccupancy,
  KNOWN_ENGINES,
  ledgerOccupancyErrorMessage,
  isLedgerOccupancyError,
  SeatOccupancyState,
  WrapperLedgerRow,
} from "../src/ledger.ts";

// Foundation: the wrapper-ledger row is the seat-occupancy authority. Mirror of
// tmuxctld/lib/tmuxctl/wrapper_ledger.py :: WrapperLedgerRow (frozen dataclass).
const BOUND_ROW = {
  wrapper_id: "wl-001",
  instance_id: "inst-abc",
  persona: "council:custodes",
  pane_positional_id: "council:custodes",
  engine: "claude",
  working_dir: "/Users/tokenclaw/worktrees/x",
  born_epoch: 1_752_600_000.0,
  state: "SHIPPED",
} as const;

// A codex seat whose runtime is live but never entered the ledger with an instance_id.
const LATE_BIND_ROW = { ...BOUND_ROW, instance_id: "", engine: "codex", state: "OPEN" } as const;

describe("wrapper-ledger seat occupancy (foundation)", () => {
  test("a fully bound ledger row parses", () => {
    const row = WrapperLedgerRow.parse(BOUND_ROW);
    expect(row.state).toBe("SHIPPED");
    expect(row.instance_id).toBe("inst-abc");
  });

  test("instance_id may be empty (late-bind: ledger row before stamp)", () => {
    const row = WrapperLedgerRow.parse(LATE_BIND_ROW);
    expect(row.instance_id).toBe("");
  });

  test("occupancy states are OPEN | SHIPPED | CLOSED; ACTIVE is OPEN+SHIPPED", () => {
    expect(SeatOccupancyState.parse("CLOSED")).toBe("CLOSED");
    expect(() => SeatOccupancyState.parse("RETIRED")).toThrow();
    expect([...ACTIVE_OCCUPANCY_STATES].sort()).toEqual(["OPEN", "SHIPPED"]);
    expect(isActiveOccupancy("OPEN")).toBe(true);
    expect(isActiveOccupancy("CLOSED")).toBe(false);
  });

  test("known engines include claude and codex", () => {
    expect(KNOWN_ENGINES).toContain("claude");
    expect(KNOWN_ENGINES).toContain("codex");
  });

  test("the seat-without-ledger-row fault message round-trips (the codex gap)", () => {
    // occupancy.py raises ValueError(f"wrapper ledger occupancy lookup failed for {role}")
    const msg = ledgerOccupancyErrorMessage("council:pax");
    expect(msg).toBe("wrapper ledger occupancy lookup failed for council:pax");
    expect(isLedgerOccupancyError(msg)).toBe(true);
    expect(isLedgerOccupancyError("some other failure")).toBe(false);
  });
});
