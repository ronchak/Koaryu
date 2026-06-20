export type NavItem = {
  label: string;
  href: string;
  icon: string;
  prefetch?: false;
};

const HEAVY_CRM_PREFETCH_PATHS = [
  "/belt-tracker",
  "/billing",
  "/automations",
  "/reports",
  "/settings",
  "/account/data",
  "/account/settings",
] as const;

export function crmLinkPrefetch(href?: string): false | undefined {
  if (!href) {
    return undefined;
  }

  return HEAVY_CRM_PREFETCH_PATHS.some((path) => href === path || href.startsWith(`${path}/`) || href.startsWith(`${path}?`))
    ? false
    : undefined;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { label: "Students", href: "/students", icon: "Users" },
  { label: "Belt Tracker", href: "/belt-tracker", icon: "Award", prefetch: false },
  { label: "Leads", href: "/leads", icon: "UserPlus" },
  { label: "Schedule", href: "/schedule", icon: "Calendar" },
  { label: "Billing", href: "/billing", icon: "CreditCard", prefetch: false },
  { label: "Automations", href: "/automations", icon: "Zap", prefetch: false },
  { label: "Reports", href: "/reports", icon: "BarChart3", prefetch: false },
  { label: "Settings", href: "/settings", icon: "Settings", prefetch: false },
] as const;

export const APP_NAME = "Koaryu";
export const APP_TAGLINE = "A warrior's flow.";
export const APP_DESCRIPTION =
  "The daily operating system for independent martial arts studios.";
