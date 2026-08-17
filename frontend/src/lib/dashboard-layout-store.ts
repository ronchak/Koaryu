import {
  DASHBOARD_WIDGET_BY_ID,
  DASHBOARD_WIDGET_CATALOG,
  getDashboardWidgetCatalogForRole,
  isDashboardWidgetEntitled,
  isDashboardWidgetSize,
  normalizeDashboardWidgetRole,
  type DashboardWidgetId,
  type DashboardWidgetRole,
  type DashboardWidgetSize,
} from "./dashboard-widget-catalog.ts";

export const DASHBOARD_LAYOUT_NAMESPACE = "koaryu:dashboard-layout:v1:";
export const DASHBOARD_LAYOUT_VERSION = 1;

export type DashboardLayoutItem = {
  widget_id: DashboardWidgetId;
  size: DashboardWidgetSize;
};

export type DashboardLayout = {
  version: typeof DASHBOARD_LAYOUT_VERSION;
  updated_at: string;
  client_id: string;
  items: DashboardLayoutItem[];
  removed_widget_ids: DashboardWidgetId[];
};

export type DashboardLayoutIdentity = {
  userId: string;
  studioId: string;
  role: DashboardWidgetRole;
};

export type DashboardLayoutReadResult = {
  layout: DashboardLayout;
  source: "stored" | "default";
};

export interface DashboardLayoutStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

function safeIdentityPart(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    return null;
  }

  return encodeURIComponent(normalized);
}

export function buildDashboardLayoutKey(
  userId: unknown,
  studioId: unknown,
  role: unknown
): string | null {
  const normalizedRole = normalizeDashboardWidgetRole(role);
  const safeUserId = safeIdentityPart(userId);
  const safeStudioId = safeIdentityPart(studioId);
  if (!safeUserId || !safeStudioId || !normalizedRole) {
    return null;
  }

  return `${DASHBOARD_LAYOUT_NAMESPACE}${safeUserId}:${safeStudioId}:${normalizedRole}`;
}

function defaultItems(role: unknown): DashboardLayoutItem[] {
  const normalizedRole = normalizeDashboardWidgetRole(role);
  return DASHBOARD_WIDGET_CATALOG
    .filter((entry) => entry.fixed || (
      normalizedRole !== null && entry.defaultRoles.includes(normalizedRole)
    ))
    .filter((entry) => isDashboardWidgetEntitled(entry, role))
    .map((entry) => ({ widget_id: entry.id, size: entry.defaultSize }));
}

export function buildDefaultDashboardLayout(role: unknown): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    updated_at: "",
    client_id: "",
    items: defaultItems(role),
    removed_widget_ids: [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRemovedIds(value: unknown, role: unknown): DashboardWidgetId[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<DashboardWidgetId>();
  const removed: DashboardWidgetId[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      continue;
    }
    const entry = DASHBOARD_WIDGET_BY_ID.get(candidate as DashboardWidgetId);
    if (!entry || entry.fixed || !isDashboardWidgetEntitled(entry, role) || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    removed.push(entry.id);
  }
  return removed;
}

export function reconcileDashboardLayout(value: unknown, role: unknown): DashboardLayout {
  const fallback = buildDefaultDashboardLayout(role);
  if (!isObject(value) || value.version !== DASHBOARD_LAYOUT_VERSION || !Array.isArray(value.items)) {
    return fallback;
  }

  const removedWidgetIds = parseRemovedIds(value.removed_widget_ids, role);
  const removed = new Set(removedWidgetIds);
  const seen = new Set<DashboardWidgetId>();
  const items: DashboardLayoutItem[] = [];

  for (const candidate of value.items) {
    if (!isObject(candidate) || typeof candidate.widget_id !== "string") {
      continue;
    }

    const entry = DASHBOARD_WIDGET_BY_ID.get(candidate.widget_id as DashboardWidgetId);
    if (!entry || !isDashboardWidgetEntitled(entry, role) || seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);
    removed.delete(entry.id);
    items.push({
      widget_id: entry.id,
      size: isDashboardWidgetSize(candidate.size) && entry.allowedSizes.includes(candidate.size)
        ? candidate.size
        : entry.defaultSize,
    });
  }

  const fixedEntry = DASHBOARD_WIDGET_CATALOG.find((entry) => entry.fixed);
  if (fixedEntry) {
    const fixedIndex = items.findIndex((item) => item.widget_id === fixedEntry.id);
    if (fixedIndex >= 0) {
      const [fixedItem] = items.splice(fixedIndex, 1);
      if (fixedItem) {
        items.unshift(fixedItem);
      }
    } else {
      items.unshift({ widget_id: fixedEntry.id, size: fixedEntry.defaultSize });
      seen.add(fixedEntry.id);
    }
  }

  for (const entry of DASHBOARD_WIDGET_CATALOG) {
    const normalizedRole = normalizeDashboardWidgetRole(role);
    const isDefault = entry.fixed || (
      normalizedRole !== null && entry.defaultRoles.includes(normalizedRole)
    );
    if (
      isDefault
      && isDashboardWidgetEntitled(entry, role)
      && !seen.has(entry.id)
      && !removed.has(entry.id)
    ) {
      seen.add(entry.id);
      items.push({ widget_id: entry.id, size: entry.defaultSize });
    }
  }

  return {
    version: DASHBOARD_LAYOUT_VERSION,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
    client_id: typeof value.client_id === "string" ? value.client_id : "",
    items,
    removed_widget_ids: Array.from(removed),
  };
}

function browserStorage(): DashboardLayoutStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDashboardLayout(
  storage: DashboardLayoutStorage | null | undefined,
  identity: DashboardLayoutIdentity
): DashboardLayoutReadResult {
  const fallback = buildDefaultDashboardLayout(identity.role);
  const key = buildDashboardLayoutKey(identity.userId, identity.studioId, identity.role);
  if (!storage || !key) {
    return { layout: fallback, source: "default" };
  }

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return { layout: fallback, source: "default" };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== DASHBOARD_LAYOUT_VERSION || !Array.isArray(parsed.items)) {
      return { layout: fallback, source: "default" };
    }
    return { layout: reconcileDashboardLayout(parsed, identity.role), source: "stored" };
  } catch {
    return { layout: fallback, source: "default" };
  }
}

export function createDashboardLayoutClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // The timestamp/random fallback remains anonymous and is generated only at the browser write boundary.
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function writeDashboardLayout(
  storage: DashboardLayoutStorage | null | undefined,
  identity: DashboardLayoutIdentity,
  value: unknown,
  options: { now?: () => string; createClientId?: () => string } = {}
): { ok: boolean; layout: DashboardLayout } {
  const reconciled = reconcileDashboardLayout(value, identity.role);
  const key = buildDashboardLayoutKey(identity.userId, identity.studioId, identity.role);
  const layout = {
    ...reconciled,
    updated_at: (options.now ?? (() => new Date().toISOString()))(),
    client_id: reconciled.client_id || (options.createClientId ?? createDashboardLayoutClientId)(),
  };
  if (!storage || !key) {
    return { ok: false, layout };
  }

  try {
    storage.setItem(key, JSON.stringify(layout));
    return { ok: true, layout };
  } catch {
    return { ok: false, layout };
  }
}

export function getBrowserDashboardLayoutStorage(): DashboardLayoutStorage | null {
  return browserStorage();
}

export function purgeDashboardLayoutNamespace(
  storage: DashboardLayoutStorage | null | undefined = browserStorage()
): number {
  if (!storage) {
    return 0;
  }

  const matchingKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(DASHBOARD_LAYOUT_NAMESPACE)) {
        matchingKeys.push(key);
      }
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of matchingKeys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Continue purging independently addressable keys when one removal fails.
    }
  }
  return removed;
}

export function getAddableDashboardWidgets(
  role: unknown,
  items: readonly DashboardLayoutItem[]
) {
  const present = new Set(items.map((item) => item.widget_id));
  return getDashboardWidgetCatalogForRole(role).filter((entry) => !present.has(entry.id));
}
