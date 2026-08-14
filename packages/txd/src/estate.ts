// The canonical persistent tmux estate for k12-personal.
//
// Compass pages declare every seat and preserve their construction geometry.
// Mitosis pages declare only their permanent allocation pane; worker panes are
// minted at dispatch and use tmux's native tiled layout. Their canonical ids
// remain physical routing handles, never agent identity.

export const TXD_SESSION = 'main';

export const TXD_STACK_WINDOWS = {
  mechanicus: 'mechanicus:new',
  palace_fleet: 'palace_fleet:new',
  somnium_fleet: 'somnium_fleet:new',
} as const;

export const TXD_WINDOWS = {
  // Object order is window order on a fresh rotation: 0 through 5.
  mechanicus: [TXD_STACK_WINDOWS.mechanicus],
  palace: ['palace:W', 'palace:N', 'palace:S', 'palace:E'],
  somnium: ['somnium:W', 'somnium:N', 'somnium:S', 'somnium:NE', 'somnium:SE'],
  council: ['council:custodes', 'council:fabricator-general', 'council:pax', 'council:orchestrator'],
  palace_fleet: [TXD_STACK_WINDOWS.palace_fleet],
  somnium_fleet: [TXD_STACK_WINDOWS.somnium_fleet],
} as const;

export type TxdPage = keyof typeof TXD_WINDOWS;
export type TxdStackPage = keyof typeof TXD_STACK_WINDOWS;

export function isTxdPage(value: string): value is TxdPage {
  return Object.hasOwn(TXD_WINDOWS, value);
}

export function isStackPage(value: string): value is TxdStackPage {
  return Object.hasOwn(TXD_STACK_WINDOWS, value);
}

export function isStackSeat(seatId: string): boolean {
  const separator = seatId.indexOf(':');
  return separator > 0
    && isStackPage(seatId.slice(0, separator))
    && seatId.length > separator + 1;
}

export function seatBelongsToPage(page: string, seatId: string): boolean {
  if (!isTxdPage(page)) return false;
  if (isStackPage(page)) return seatId.startsWith(`${page}:`) && seatId.length > page.length + 1;
  return (TXD_WINDOWS[page] as readonly string[]).includes(seatId);
}

/** The panes a flat rotation creates. Dynamic mitosis workers are added later. */
export const TXD_ESTATE: readonly string[] = Object.values(TXD_WINDOWS).flat();

// somnium and somnium_fleet run one wrapper-per-pane on k12-work. The dynamic
// suffix is irrelevant to placement; the page is the transport declaration.
export const SSH_SEAT_TARGETS: Readonly<Record<string, string>> = Object.fromEntries([
  ...TXD_WINDOWS.somnium,
  TXD_STACK_WINDOWS.somnium_fleet,
].map((seat) => [seat, 'k12-work']));

export function sshSeatTarget(seatId: string): string | undefined {
  const page = seatId.split(':', 1)[0];
  return page === 'somnium' || page === 'somnium_fleet' ? 'k12-work' : undefined;
}
