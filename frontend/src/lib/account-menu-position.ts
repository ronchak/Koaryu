export interface AccountMenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  compactLayout: boolean;
}

interface TriggerRect {
  left: number;
  top: number;
  bottom: number;
}

interface AccountMenuPositionInput {
  triggerRect: TriggerRect;
  viewportWidth: number;
  viewportHeight: number;
  hasSubmenu: boolean;
}

interface AccountMenuPanelWidthInput {
  compactLayout: boolean;
  hasSubmenu: boolean;
  viewportWidth?: number;
}

export const ACCOUNT_MENU_WIDTH = 272;
export const ACCOUNT_SUBMENU_WIDTH = 260;
export const ACCOUNT_MENU_GAP = 8;
export const ACCOUNT_MENU_VIEWPORT_GUTTER = 8;
export const ACCOUNT_MENU_COMPACT_BREAKPOINT = 640;
export const ACCOUNT_MENU_CLOSE_DELAY_MS = 340;

export function calculateAccountMenuPanelWidth({
  compactLayout,
  hasSubmenu,
  viewportWidth,
}: AccountMenuPanelWidthInput) {
  if (compactLayout) {
    return Math.min(
      ACCOUNT_MENU_WIDTH,
      (viewportWidth ?? ACCOUNT_MENU_WIDTH + ACCOUNT_MENU_VIEWPORT_GUTTER * 2) -
        ACCOUNT_MENU_VIEWPORT_GUTTER * 2
    );
  }

  return hasSubmenu
    ? ACCOUNT_MENU_WIDTH + ACCOUNT_SUBMENU_WIDTH + ACCOUNT_MENU_GAP
    : ACCOUNT_MENU_WIDTH;
}

export function calculateAccountMenuPosition({
  triggerRect,
  viewportWidth,
  viewportHeight,
  hasSubmenu,
}: AccountMenuPositionInput): AccountMenuPosition {
  const compactLayout = viewportWidth < ACCOUNT_MENU_COMPACT_BREAKPOINT;
  const width = calculateAccountMenuPanelWidth({
    compactLayout,
    hasSubmenu,
    viewportWidth,
  });
  const maxLeft = viewportWidth - width - ACCOUNT_MENU_VIEWPORT_GUTTER;
  const left = Math.min(
    Math.max(triggerRect.left, ACCOUNT_MENU_VIEWPORT_GUTTER),
    Math.max(ACCOUNT_MENU_VIEWPORT_GUTTER, maxLeft)
  );

  if (triggerRect.top > viewportHeight / 2) {
    const bottom = Math.max(
      ACCOUNT_MENU_VIEWPORT_GUTTER,
      viewportHeight - triggerRect.top + ACCOUNT_MENU_GAP
    );

    return {
      left,
      compactLayout,
      bottom,
      maxHeight: Math.max(180, viewportHeight - bottom - ACCOUNT_MENU_VIEWPORT_GUTTER),
    };
  }

  const top = Math.min(
    triggerRect.bottom + ACCOUNT_MENU_GAP,
    viewportHeight - ACCOUNT_MENU_VIEWPORT_GUTTER
  );

  return {
    left,
    compactLayout,
    top,
    maxHeight: Math.max(180, viewportHeight - top - ACCOUNT_MENU_VIEWPORT_GUTTER),
  };
}
