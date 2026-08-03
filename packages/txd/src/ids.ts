// Canonical-id membrane (spec §7 rung 2).
//
// Canonical ids (seat names like `somnium:NE`) are the ONLY id surface the
// daemon exposes. Raw tmux ids — pane `%N`, window `@N`, session `$N` — live
// strictly BELOW the tmux control plane and must never appear in an API
// response, a log line, or an event payload. This module is the guard that
// makes that invariant testable: the control plane translates at the membrane,
// and `assertNoTmuxIdInIdentifiers` fails loud if an IDENTIFIER leaks upward.

import { findTmuxIdInIdentifiers } from '@terminus-os/contracts';

export { findTmuxId, sanitizeTmuxIds, findTmuxIdInIdentifiers } from '@terminus-os/contracts';

/**
 * The leak-upward invariant, unchanged in DIRECTION and narrowed in SUBJECT.
 *
 * txd must never expose a raw tmux id as an identifier — in a response, a log
 * line or an event payload. That protection is intact. What changed is what it
 * judges: it used to scan every string it could reach, which meant a message
 * body quoting a pane id was treated as txd leaking one. It now judges the
 * fields that claim to be identifiers, and nothing else.
 *
 * The rule itself lives in `@terminus-os/contracts` so the daemon and the `tx`
 * client judge on ONE definition. Two copies of this rule is two rules.
 */
export function assertNoTmuxIdInIdentifiers(value: unknown, where: string): void {
  const leak = findTmuxIdInIdentifiers(value);
  if (leak) {
    throw new Error(`txd canonical-id breach: raw tmux id leaked at ${where} (${leak})`);
  }
}
