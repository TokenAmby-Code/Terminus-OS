import { z } from "zod";

/**
 * Wrapper-ledger seat occupancy — the FOUNDATION the tmuxctld op envelopes consume.
 *
 * Mirror of tmuxctld/lib/tmuxctl/wrapper_ledger.py :: WrapperLedgerRow (frozen dataclass).
 * The wrapper→pane ledger is the delivery/occupancy authority for managed agents: which
 * persona seat occupies which tmux pane, and in what lifecycle state.
 */

/** Ledger row lifecycle. ACTIVE = OPEN|SHIPPED; CLOSED is terminal (kept for post-mortem). */
export const SEAT_OCCUPANCY_STATES = ["OPEN", "SHIPPED", "CLOSED"] as const;
export const SeatOccupancyState = z.enum(SEAT_OCCUPANCY_STATES);
export type SeatOccupancyStateT = z.infer<typeof SeatOccupancyState>;

/** wrapper_ledger.py :: ACTIVE_STATES = frozenset({"SHIPPED", "OPEN"}). */
export const ACTIVE_OCCUPANCY_STATES = ["OPEN", "SHIPPED"] as const;
const ACTIVE_SET: ReadonlySet<string> = new Set(ACTIVE_OCCUPANCY_STATES);
export function isActiveOccupancy(state: string): boolean {
  return ACTIVE_SET.has(state);
}

/**
 * `engine` is a free TEXT column in the `instances` table, but the fleet runs exactly two
 * today. `codex` is the one that produces the seat-without-ledger-row gap below.
 */
export const KNOWN_ENGINES = ["claude", "codex"] as const;
export const EngineId = z.string();
export type EngineIdT = z.infer<typeof EngineId>;

export const WrapperLedgerRow = z.object({
  wrapper_id: z.string(),
  // May be "" — a late-bind row: the seat exists in the ledger before SessionStart stamps
  // the instance id back onto it. See ../bind.ts :: classifyBind.
  instance_id: z.string(),
  persona: z.string(),
  pane_positional_id: z.string(),
  engine: EngineId,
  working_dir: z.string(),
  born_epoch: z.number(),
  state: SeatOccupancyState,
});
export type WrapperLedgerRowT = z.infer<typeof WrapperLedgerRow>;

/**
 * The seat-without-wrapper-row fault (the codex gap). occupancy.py raises
 *   ValueError(f"wrapper ledger occupancy lookup failed for {role}")
 * when a live seat has no OPEN/SHIPPED ledger row. On 2026-07-16 this took down the whole
 * freelist scan (see ../tmuxctld.ts FREELIST_FAIL); the per-pane fault-isolation fix demotes
 * it to a single faulted seat carrying this exact message as its `fault_reason`.
 */
export function ledgerOccupancyErrorMessage(role: string): string {
  return `wrapper ledger occupancy lookup failed for ${role}`;
}

const LEDGER_OCCUPANCY_ERROR_RE = /^wrapper ledger occupancy lookup failed for .+/;
export function isLedgerOccupancyError(message: string): boolean {
  return LEDGER_OCCUPANCY_ERROR_RE.test(message);
}
