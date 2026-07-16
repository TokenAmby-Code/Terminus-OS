import { describe, expect, test } from "bun:test";
import { ledgerOccupancyErrorMessage } from "../src/ledger.ts";
import {
  ClosePaneResponse,
  FreelistResponse,
  normalizeFreelist,
  TMUXCTLD_CONTRACT_VERSION,
} from "../src/tmuxctld.ts";

// ---- LIVE SPECIMENS observed 2026-07-16 (typed faithfully, inconsistencies included) ----

// freelist success — result is a BARE ARRAY on today's wire.
const FREELIST_OK = {
  ok: true,
  result: [
    { pane_id: "somnium:0", pane_role: "somnium:0", window_name: "somnium" },
    { pane_id: "somnium:1", pane_role: "somnium:1", window_name: "somnium" },
  ],
} as const;

// freelist fail-loud — the whole scan died on one untyped ledger row (pre fault-isolation fix).
const FREELIST_FAIL = {
  ok: false,
  error: {
    code: "ValueError",
    message: "wrapper ledger occupancy lookup failed for council:pax",
    detail: "",
  },
} as const;

// The in-flight per-pane fault-isolation shape the contract must ALSO tolerate: the scan
// no longer dies whole; the faulted seat is surfaced with its fault_reason.
const FREELIST_OK_WITH_FAULTS = {
  ok: true,
  result: {
    free: [{ pane_id: "somnium:0", pane_role: "somnium:0", window_name: "somnium" }],
    faulted: [
      {
        pane_id: "council:pax",
        pane_role: "council:pax",
        window_name: "council",
        fault_reason: ledgerOccupancyErrorMessage("council:pax"),
      },
    ],
  },
} as const;

// close-pane success A — carries ledger_released.
const CLOSE_A = {
  ok: true,
  result: {
    status: "cleared_in_place",
    pane_class: "slot",
    pane: "%20",
    pane_role: "palace:1",
    revived: false,
    chrome_cleared: true,
    pane_freed: true,
    method: "graceful-clear-in-place",
    graceful_timeout: 15.0,
    stack_enforcement: "noop stack layout main:1: unsupported window palace",
    ledger_released: true,
    retire_required: false,
    close_transaction_complete: true,
  },
} as const;

// close-pane success B — SAME op, ledger_released ABSENT (optional key).
const CLOSE_B = {
  ok: true,
  result: {
    status: "cleared_in_place",
    pane_class: "slot",
    pane: "%20",
    pane_role: "palace:1",
    revived: false,
    chrome_cleared: true,
    pane_freed: true,
    method: "graceful-clear-in-place",
    graceful_timeout: 15.0,
    stack_enforcement: "noop stack layout main:1: unsupported window palace",
    retire_required: false,
    close_transaction_complete: true,
  },
} as const;

describe("tmuxctld freelist (consumes ledger/registration seat types)", () => {
  test("today's bare-array success specimen parses", () => {
    const parsed = FreelistResponse.parse(FREELIST_OK);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(normalizeFreelist(parsed.result).free).toHaveLength(2);
  });

  test("fail-loud specimen parses as the error arm; message is the ledger occupancy fault", () => {
    const parsed = FreelistResponse.parse(FREELIST_FAIL);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toBe(ledgerOccupancyErrorMessage("council:pax"));
    }
  });

  test("tolerates the future {free,faulted} pool; faulted carries the ledger fault_reason", () => {
    const parsed = FreelistResponse.parse(FREELIST_OK_WITH_FAULTS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const pool = normalizeFreelist(parsed.result);
      expect(pool.free).toHaveLength(1);
      expect(pool.faulted).toHaveLength(1);
      expect(pool.faulted[0]?.fault_reason).toContain("occupancy lookup failed");
    }
  });

  test("normalizeFreelist collapses the bare array to {free, faulted:[]}", () => {
    expect(normalizeFreelist(FREELIST_OK.result)).toEqual({
      free: [...FREELIST_OK.result],
      faulted: [],
    });
  });
});

describe("tmuxctld close-pane (releases ledger occupancy)", () => {
  test("success A parses with ledger_released present", () => {
    const parsed = ClosePaneResponse.parse(CLOSE_A);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.ledger_released).toBe(true);
  });

  test("success B parses with ledger_released ABSENT (optional)", () => {
    const parsed = ClosePaneResponse.parse(CLOSE_B);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.ledger_released).toBeUndefined();
  });

  test("contract version is stamped", () => {
    expect(TMUXCTLD_CONTRACT_VERSION).toBe("tmuxctld.v1");
  });
});
