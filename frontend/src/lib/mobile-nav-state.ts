const PANEL_BASE_CLASS =
  "fixed top-0 right-0 z-50 h-full w-72 bg-surface border-l border-border flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]";

export function getMobileNavPanelState(open: boolean) {
  return {
    state: open ? "open" : "closed",
    ariaHidden: !open,
    inert: !open,
    className: `${PANEL_BASE_CLASS} ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`,
  };
}
