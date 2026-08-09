// The canonical persistent tmux estate for k12-personal (rung 2).
//
// This is the DECLARATION the boot-time constructor stands (see
// Daemon.constructEstate in core.ts). It defines the estate's
// current shape — `tmuxctld/lib/tmuxctl/builder.py:build_workspace` — NOT
// invented here. Each seat traces to its builder.py origin so a reviewer can
// audit the mirror. Canonical ids only (colons and all); the tmux membrane in
// tmux.ts sanitizes them into session names.
//
export const TXD_SESSION = 'main';

export const TXD_WINDOWS = {
  reservists: ['reservists:W', 'reservists:N', 'reservists:S', 'reservists:E'],
  palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
  somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
  // Positional declaration: NW, SW, NE, SE.
  council: ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'],
} as const;

export type TxdPage = keyof typeof TXD_WINDOWS;

export function isTxdPage(value: string): value is TxdPage {
  return Object.hasOwn(TXD_WINDOWS, value);
}

export const TXD_ESTATE: readonly string[] = [
  // ── Workspace grids (build_workspace stack panes) ──────────────────────────
  // reservists: the reserve 4-pane stack (W/N/S/E), deliberately at window 0.
  'reservists:W',
  'reservists:N',
  'reservists:S',
  'reservists:E',
  // palace: the primary 4-pane orchestration stack (W/N/S/E).
  'palace:W',
  'palace:N',
  'palace:S',
  'palace:E',
  // somnium: the 5-pane stack (W/N/S + NE/SE split column).
  'somnium:W',
  'somnium:N',
  'somnium:S',
  'somnium:NE',
  'somnium:SE',

  // ── Fixed Council command page (NW, SW, NE, SE) ───────────────────────────
  'council:custodes',
  'council:fabricator-general',
  'council:pax',
  'council:orchestrator',
];

// ── ssh seats ────────────────────────────────────────────────────────────────
// An ssh seat is an ordinary estate seat whose pane command is the LOCAL
// agent-wrapper owning an ssh transport into a one-pane tmux envelope on the
// declared target machine. The target names a machines.json alias — never an
// address; addresses resolve through the generated ~/.ssh/config host blocks.
// somnium is the k12-work page: its engines live in k12-work envelopes while
// registration, estate, and bus authority stay on k12-personal.
export const SSH_SEAT_TARGETS: Readonly<Record<string, string>> = {
  'somnium:W': 'k12-work',
  'somnium:N': 'k12-work',
  'somnium:S': 'k12-work',
  'somnium:NE': 'k12-work',
  'somnium:SE': 'k12-work',
};

/** The seat's declared ssh target alias; undefined for a local seat. */
export function sshSeatTarget(seatId: string): string | undefined {
  return SSH_SEAT_TARGETS[seatId];
}
