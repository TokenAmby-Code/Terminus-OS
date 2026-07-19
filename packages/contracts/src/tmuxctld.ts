import { z } from "zod";
import { envelope } from "./envelope.ts";

/**
 * tmuxctld op contracts — CONSUMERS of the registration/bind/ledger foundation.
 *
 * These envelope the daemon loopback ops observed 2026-07-16. A freed pane's `pane_role` is a
 * seat label from the wrapper ledger (../ledger.ts pane_positional_id); a faulted seat's
 * `fault_reason` is the ledger occupancy error (../ledger.ts ledgerOccupancyErrorMessage);
 * close-pane's `ledger_released` reports the release of that seat's ledger occupancy.
 */
export const TMUXCTLD_CONTRACT_VERSION = "tmuxctld.v1";

// ---------- GET /freelist ----------

/** A free pane in the dispatch pool. Handler: daemon.py :: _h_freelist. */
export const FreePane = z.object({
  pane_id: z.string(),
  pane_role: z.string(),
  window_name: z.string(),
});
export type FreePaneT = z.infer<typeof FreePane>;

/**
 * A seat excluded from dispatch by a per-pane fault. `fault_reason` is the stringified
 * occupancy exception (the codex seat-without-ledger-row gap surfaces here as
 * "wrapper ledger occupancy lookup failed for <role>").
 */
export const FaultedSeat = FreePane.extend({ fault_reason: z.string() });
export type FaultedSeatT = z.infer<typeof FaultedSeat>;

/** The convergent freelist shape once per-pane fault-isolation ships. */
export const FreelistPool = z.object({
  free: z.array(FreePane),
  faulted: z.array(FaultedSeat),
});
export type FreelistPoolT = z.infer<typeof FreelistPool>;

/**
 * Freelist result. TODAY the wire carries a BARE ARRAY of free panes; the in-flight fault-
 * isolation fix converges it to `{ free, faulted }`. The contract tolerates BOTH so it does
 * not have to break when the service ships the fix.
 */
export const FreelistResult = z.union([z.array(FreePane), FreelistPool]);
export type FreelistResultT = z.infer<typeof FreelistResult>;

/** Normalise either freelist shape to `{ free, faulted }` for consumers. */
export function normalizeFreelist(
  result: readonly FreePaneT[] | FreelistPoolT,
): { free: readonly FreePaneT[]; faulted: readonly FaultedSeatT[] } {
  return "free" in result
    ? { free: result.free, faulted: result.faulted }
    : { free: result, faulted: [] };
}

/** GET /freelist takes no params on the loopback. */
export const FreelistRequest = z.object({});
export type FreelistRequestT = z.infer<typeof FreelistRequest>;

export const FreelistResponse = envelope(FreelistResult);
export type FreelistResponseT = z.infer<typeof FreelistResponse>;

// ---------- POST /close-pane ----------

/** daemon.py :: _h_close_pane accepts a pane target and a graceful timeout (default 3.0s). */
export const ClosePaneRequest = z.object({
  pane: z.string(),
  timeout: z.number().optional(),
});
export type ClosePaneRequestT = z.infer<typeof ClosePaneRequest>;

/**
 * close-pane success result, typed faithfully to the two live specimens (both "cleared_in_place").
 * `ledger_released` is OPTIONAL: specimen A carried it (true), specimen B — the SAME op — omitted
 * it entirely. It is added only when the ledger occupancy is actually released.
 *
 * Free-form strings (`status`, `method`, `stack_enforcement`) are kept as strings, not enums:
 * `stack_enforcement` is a whole diagnostic sentence in the wild. The refused/other status
 * branches carry different keys and get their own variants when specimens are captured.
 */
export const ClosePaneResult = z.object({
  status: z.string(),
  pane_class: z.string(),
  pane: z.string(),
  pane_role: z.string(),
  revived: z.boolean(),
  chrome_cleared: z.boolean(),
  pane_freed: z.boolean(),
  method: z.string(),
  graceful_timeout: z.number(),
  stack_enforcement: z.string(),
  ledger_released: z.boolean().optional(),
  retire_required: z.boolean(),
  close_transaction_complete: z.boolean(),
});
export type ClosePaneResultT = z.infer<typeof ClosePaneResult>;

export const ClosePaneResponse = envelope(ClosePaneResult);
export type ClosePaneResponseT = z.infer<typeof ClosePaneResponse>;
