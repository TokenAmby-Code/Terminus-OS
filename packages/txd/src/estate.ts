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

// Each Council pane hosts a full terminal TUI whose declared minimum usable
// viewport is the conventional 80 columns. Two columns are therefore selected
// only when both panes retain that viewport after tmux's one vertical border:
// 2 * minimumUsableColumns + verticalBorders. The breakpoint is derived from
// those pane requirements; no client or device width is canonical by itself.
//
// Wide Council owns one horizontal border between its two rows. The remaining
// rows are divided two-to-one, with the nearest integer assigned to the top.
// Narrow Council owns three horizontal borders and stacks the two former
// columns, retaining the same two-to-one division within each pair.
export const COUNCIL_GEOMETRY = {
  pane: { minimumUsableColumns: 80 },
  top: { numerator: 2, denominator: 3 },
  horizontalBorders: 1,
  stackedHorizontalBorders: 3,
  verticalBorders: 1,
} as const;

export type CouncilPaneGeometry = { left: number; top: number; width: number; height: number };
export type CouncilGeometry = {
  shape: 'columns' | 'stack';
  panes: readonly [CouncilPaneGeometry, CouncilPaneGeometry, CouncilPaneGeometry, CouncilPaneGeometry];
};

export function councilGeometryRows(windowHeight: number): { top: number; bottom: number } {
  const usable = windowHeight - COUNCIL_GEOMETRY.horizontalBorders;
  const top = Math.round(usable * COUNCIL_GEOMETRY.top.numerator / COUNCIL_GEOMETRY.top.denominator);
  return { top, bottom: usable - top };
}

/** Canonical Council projection derived solely from the observed window. */
export function councilGeometry(windowWidth: number, windowHeight: number): CouncilGeometry {
  const columnFloor = (2 * COUNCIL_GEOMETRY.pane.minimumUsableColumns) + COUNCIL_GEOMETRY.verticalBorders;
  if (windowWidth >= columnFloor) {
    const rows = councilGeometryRows(windowHeight);
    const usableWidth = windowWidth - COUNCIL_GEOMETRY.verticalBorders;
    const westWidth = Math.round(usableWidth / 2);
    const eastWidth = usableWidth - westWidth;
    return {
      shape: 'columns',
      panes: [
        { left: 0, top: 0, width: westWidth, height: rows.top },
        { left: 0, top: rows.top + 1, width: westWidth, height: rows.bottom },
        { left: westWidth + 1, top: 0, width: eastWidth, height: rows.top },
        { left: westWidth + 1, top: rows.top + 1, width: eastWidth, height: rows.bottom },
      ],
    };
  }

  const usableHeight = windowHeight - COUNCIL_GEOMETRY.stackedHorizontalBorders;
  const westPairRows = Math.round(usableHeight / 2);
  const eastPairRows = usableHeight - westPairRows;
  const westTop = Math.round(westPairRows * COUNCIL_GEOMETRY.top.numerator / COUNCIL_GEOMETRY.top.denominator);
  const eastTop = Math.round(eastPairRows * COUNCIL_GEOMETRY.top.numerator / COUNCIL_GEOMETRY.top.denominator);
  const westBottom = westPairRows - westTop;
  const eastBottom = eastPairRows - eastTop;
  return {
    shape: 'stack',
    panes: [
      { left: 0, top: 0, width: windowWidth, height: westTop },
      { left: 0, top: westTop + 1, width: windowWidth, height: westBottom },
      { left: 0, top: westPairRows + 2, width: windowWidth, height: eastTop },
      { left: 0, top: westPairRows + eastTop + 3, width: windowWidth, height: eastBottom },
    ],
  };
}

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
