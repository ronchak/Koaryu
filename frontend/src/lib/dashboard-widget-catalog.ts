export const DASHBOARD_WIDGET_SIZES = ["1x1", "2x1", "2x2", "4x1", "4x2"] as const;

export type DashboardWidgetSize = (typeof DASHBOARD_WIDGET_SIZES)[number];
export type DashboardWidgetRole = "admin" | "front_desk" | "instructor";
export type DashboardWidgetCategory = "today" | "people" | "money" | "setup";
export type DashboardWidgetId =
  | "needs_attention"
  | "classes_today"
  | "student_pulse"
  | "attendance"
  | "lead_follow_ups"
  | "promotions_due"
  | "billing_exceptions"
  | "revenue_due"
  | "setup_progress"
  | "recent_students"
  | "saved_report"
  | "quick_actions"
  | "emergency_contacts";

export type DashboardWidgetStateCopy = {
  loading: string;
  error: string;
  empty: string;
  partial: string;
  unavailable: string;
};

export type DashboardWidgetCatalogEntry = {
  id: DashboardWidgetId;
  title: string;
  allowedRoles: readonly DashboardWidgetRole[];
  allowedSizes: readonly DashboardWidgetSize[];
  defaultSize: DashboardWidgetSize;
  defaultRoles: readonly DashboardWidgetRole[];
  sourceRoute: string;
  category: DashboardWidgetCategory;
  fixed: boolean;
  removable: boolean;
  provenanceCopy: string;
  windowCopy: string;
  stateCopy: DashboardWidgetStateCopy;
};

const ALL_ROLES: readonly DashboardWidgetRole[] = ["admin", "front_desk", "instructor"];
const OPERATIONS_ROLES: readonly DashboardWidgetRole[] = ["admin", "front_desk"];
const PROMOTION_ROLES: readonly DashboardWidgetRole[] = ["admin", "instructor"];

const standardStateCopy = (subject: string): DashboardWidgetStateCopy => ({
  loading: `${subject} is loading.`,
  error: `${subject} could not be loaded.`,
  empty: `No ${subject.toLowerCase()} in this window.`,
  partial: `${subject} is limited by the current partial dataset.`,
  unavailable: `${subject} is unavailable from the current summary.`,
});

export const DASHBOARD_WIDGET_CATALOG: readonly DashboardWidgetCatalogEntry[] = [
  {
    id: "needs_attention",
    title: "Needs Attention",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["2x2"],
    defaultSize: "2x2",
    defaultRoles: ALL_ROLES,
    sourceRoute: "/dashboard",
    category: "today",
    fixed: true,
    removable: false,
    provenanceCopy: "Summary-owned obligations",
    windowCopy: "Oldest first",
    stateCopy: standardStateCopy("Attention items"),
  },
  {
    id: "classes_today",
    title: "Classes Today",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["2x1", "2x2"],
    defaultSize: "2x2",
    defaultRoles: ALL_ROLES,
    sourceRoute: "/schedule",
    category: "today",
    fixed: false,
    removable: true,
    provenanceCopy: "Schedule owner",
    windowCopy: "Studio day",
    stateCopy: standardStateCopy("Today’s classes"),
  },
  {
    id: "student_pulse",
    title: "Student Pulse",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "1x1",
    defaultRoles: ALL_ROLES,
    sourceRoute: "/students",
    category: "people",
    fixed: false,
    removable: true,
    provenanceCopy: "Dashboard summary",
    windowCopy: "Current roster",
    stateCopy: standardStateCopy("Student totals"),
  },
  {
    id: "attendance",
    title: "Attendance",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "1x1",
    defaultRoles: ALL_ROLES,
    sourceRoute: "/schedule",
    category: "today",
    fixed: false,
    removable: true,
    provenanceCopy: "Attendance register",
    windowCopy: "Last 30 days",
    stateCopy: standardStateCopy("Attendance"),
  },
  {
    id: "lead_follow_ups",
    title: "Lead Follow-ups",
    allowedRoles: OPERATIONS_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "2x1",
    defaultRoles: OPERATIONS_ROLES,
    sourceRoute: "/leads",
    category: "people",
    fixed: false,
    removable: true,
    provenanceCopy: "Lead follow-up ledger",
    windowCopy: "Due through today",
    stateCopy: standardStateCopy("Lead follow-ups"),
  },
  {
    id: "promotions_due",
    title: "Promotions Due",
    allowedRoles: PROMOTION_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "2x1",
    defaultRoles: PROMOTION_ROLES,
    sourceRoute: "/belt-tracker",
    category: "people",
    fixed: false,
    removable: true,
    provenanceCopy: "Eligibility owner",
    windowCopy: "Current ladder",
    stateCopy: standardStateCopy("Promotion readiness"),
  },
  {
    id: "billing_exceptions",
    title: "Billing Exceptions",
    allowedRoles: OPERATIONS_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "2x1",
    defaultRoles: OPERATIONS_ROLES,
    sourceRoute: "/billing?tab=invoices",
    category: "money",
    fixed: false,
    removable: true,
    provenanceCopy: "Billing-safe dashboard summary",
    windowCopy: "Current attention queue",
    stateCopy: standardStateCopy("Billing exceptions"),
  },
  {
    id: "revenue_due",
    title: "Revenue Due",
    allowedRoles: OPERATIONS_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "2x1",
    defaultRoles: [],
    sourceRoute: "/billing",
    category: "money",
    fixed: false,
    removable: true,
    provenanceCopy: "Billing source required",
    windowCopy: "This week",
    stateCopy: standardStateCopy("Revenue due"),
  },
  {
    id: "setup_progress",
    title: "Setup Progress",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["1x1", "2x1"],
    defaultSize: "1x1",
    defaultRoles: ["admin"],
    sourceRoute: "/settings",
    category: "setup",
    fixed: false,
    removable: true,
    provenanceCopy: "Studio setup checklist",
    windowCopy: "Current configuration",
    stateCopy: standardStateCopy("Setup progress"),
  },
  {
    id: "recent_students",
    title: "Recent Students",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["2x1", "2x2"],
    defaultSize: "2x1",
    defaultRoles: [],
    sourceRoute: "/students",
    category: "people",
    fixed: false,
    removable: true,
    provenanceCopy: "Dashboard summary or complete roster",
    windowCopy: "Most recent five",
    stateCopy: standardStateCopy("Recent students"),
  },
  {
    id: "saved_report",
    title: "Saved Report",
    allowedRoles: OPERATIONS_ROLES,
    allowedSizes: ["2x1", "2x2"],
    defaultSize: "2x1",
    defaultRoles: [],
    sourceRoute: "/reports",
    category: "setup",
    fixed: false,
    removable: true,
    provenanceCopy: "Saved report source required",
    windowCopy: "Saved window",
    stateCopy: standardStateCopy("Saved report"),
  },
  {
    id: "quick_actions",
    title: "Quick Actions",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["2x1", "4x1"],
    defaultSize: "2x1",
    defaultRoles: ALL_ROLES,
    sourceRoute: "/dashboard",
    category: "setup",
    fixed: false,
    removable: true,
    provenanceCopy: "Koaryu route shortcuts",
    windowCopy: "Available now",
    stateCopy: standardStateCopy("Quick actions"),
  },
  {
    id: "emergency_contacts",
    title: "Emergency Contacts",
    allowedRoles: ALL_ROLES,
    allowedSizes: ["2x1", "2x2"],
    defaultSize: "2x1",
    defaultRoles: ["admin", "front_desk"],
    sourceRoute: "/students",
    category: "people",
    fixed: false,
    removable: true,
    provenanceCopy: "Complete active roster · contact name only",
    windowCopy: "Current roster",
    stateCopy: standardStateCopy("Emergency-contact names"),
  },
] as const;

export const DASHBOARD_WIDGET_BY_ID = new Map(
  DASHBOARD_WIDGET_CATALOG.map((entry) => [entry.id, entry])
);

export function normalizeDashboardWidgetRole(role: unknown): DashboardWidgetRole | null {
  return role === "admin" || role === "front_desk" || role === "instructor" ? role : null;
}

export function isDashboardWidgetEntitled(
  entry: DashboardWidgetCatalogEntry,
  role: unknown
): boolean {
  if (entry.fixed) {
    return true;
  }

  const normalizedRole = normalizeDashboardWidgetRole(role);
  return normalizedRole !== null && entry.allowedRoles.includes(normalizedRole);
}

export function getDashboardWidgetCatalogForRole(role: unknown): DashboardWidgetCatalogEntry[] {
  return DASHBOARD_WIDGET_CATALOG.filter((entry) => isDashboardWidgetEntitled(entry, role));
}

export function isDashboardWidgetSize(value: unknown): value is DashboardWidgetSize {
  return typeof value === "string" && DASHBOARD_WIDGET_SIZES.includes(value as DashboardWidgetSize);
}
