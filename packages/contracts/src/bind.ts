import { z } from "zod";
import type { WrapperLedgerRowT } from "./ledger.ts";

/**
 * Bind lifecycle — the FOUNDATION state machine the old package never had.
 *
 * Binding is NOT a single DB column. It is derived from three signals:
 *   1. the instance registration row exists;
 *   2. the pane carries an `@INSTANCE_ID` stamp (written at SessionStart);
 *   3. a wrapper-ledger row exists and carries a non-empty `instance_id`.
 *
 * Semantics per tmuxctld/lib/tmuxctl/service.py + wrapper_ledger.py:
 *   registered  — row exists; no pane stamp, no ledger row yet.
 *   bound       — stamp present AND ledger row carries the instance_id.
 *   late-bind   — ledger row exists but binding is incomplete (instance_id "" or no stamp).
 *                 Two live late-bind specimens were observed 2026-07-16.
 *   never-bind  — live via `@INSTANCE_ID` stamp but NO ledger row at all. The codex gap:
 *                 codex workers may never enter the wrapper ledger.
 */
export const BIND_STATES = ["registered", "bound", "late-bind", "never-bind"] as const;
export const BindState = z.enum(BIND_STATES);
export type BindStateT = z.infer<typeof BindState>;

export interface BindSignals {
  /** the instance registration row exists (registration happened). */
  has_instance_row: boolean;
  /** the pane's `@INSTANCE_ID` stamp; "" = unstamped. */
  instance_stamp: string;
  /** the seat's wrapper-ledger row, or null when the seat has none. */
  ledger_row: WrapperLedgerRowT | null;
}

export function classifyBind(signals: BindSignals): BindStateT {
  const { instance_stamp, ledger_row } = signals;
  const stamped = instance_stamp.trim() !== "";

  if (ledger_row !== null) {
    // Ledger row present: bound only when the row carries the instance_id AND the pane is
    // stamped. Anything short of that is a late-bind (row landed before the bind completed).
    if (ledger_row.instance_id.trim() !== "" && stamped) return "bound";
    return "late-bind";
  }

  // No ledger row. A live stamp with no ledger row is the codex never-bind gap; otherwise the
  // instance is merely registered and not yet bound to a pane.
  return stamped ? "never-bind" : "registered";
}
