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

// The Emperor's ssh pane. The remote-close verb hard-refuses this seat
// regardless of binding state or force — closing it would sever the operator.
export const EMPEROR_SEAT = 'palace:N';

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

export const DECOMMISSIONED_COUNCIL_SEATS = [
  'council:malcador',
  'council:true-terminal',
  'council:administratum',
  'mechanicus:fabricator-general',
  'mechanicus:orchestrator',
] as const;
