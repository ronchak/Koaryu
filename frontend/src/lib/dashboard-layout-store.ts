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
export const DASHBOARD_LAYOUT_VERSION = 2;
export const DASHBOARD_LAYOUT_COLUMNS = 4;
// Every catalog panel still fits when all 13 use their largest 2x2 footprint: two per row band.
export const DASHBOARD_LAYOUT_MAX_ROWS = Math.ceil(DASHBOARD_WIDGET_CATALOG.length / 2) * 2;

export type DashboardLayoutItem = {
  widget_id: DashboardWidgetId;
  size: DashboardWidgetSize;
  column: number;
  row: number;
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

type Footprint = { columns: number; rows: number };
type CandidateItem = Omit<DashboardLayoutItem, "column" | "row"> & {
  column?: number;
  row?: number;
};

const LEGACY_SIZE_MAP: Readonly<Record<string, DashboardWidgetSize>> = {
  "4x1": "2x1",
  "4x2": "2x2",
};

export function getDashboardWidgetFootprint(size: DashboardWidgetSize): Footprint {
  if (size === "1x1") return { columns: 1, rows: 1 };
  if (size === "2x1") return { columns: 2, rows: 1 };
  if (size === "1x2") return { columns: 1, rows: 2 };
  return { columns: 2, rows: 2 };
}

function isGridCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDashboardRow(value: unknown, size: DashboardWidgetSize): value is number {
  return isGridCoordinate(value)
    && Number(value) + getDashboardWidgetFootprint(size).rows <= DASHBOARD_LAYOUT_MAX_ROWS;
}

function cellsFor(item: DashboardLayoutItem): string[] {
  const footprint = getDashboardWidgetFootprint(item.size);
  const cells: string[] = [];
  for (let row = item.row; row < item.row + footprint.rows; row += 1) {
    for (let column = item.column; column < item.column + footprint.columns; column += 1) {
      cells.push(`${column}:${row}`);
    }
  }
  return cells;
}

function canPlace(
  item: Pick<DashboardLayoutItem, "size">,
  column: number,
  row: number,
  occupied: ReadonlySet<string>,
  columns: number
): boolean {
  const footprint = getDashboardWidgetFootprint(item.size);
  if (column < 0 || row < 0 || column + footprint.columns > columns) return false;
  for (let checkRow = row; checkRow < row + footprint.rows; checkRow += 1) {
    for (let checkColumn = column; checkColumn < column + footprint.columns; checkColumn += 1) {
      if (occupied.has(`${checkColumn}:${checkRow}`)) return false;
    }
  }
  return true;
}

function firstFit(
  item: Pick<DashboardLayoutItem, "size">,
  occupied: ReadonlySet<string>,
  columns: number,
  startAt = 0
): { column: number; row: number } {
  const footprint = getDashboardWidgetFootprint(item.size);
  for (let index = Math.max(0, startAt); ; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    if (column + footprint.columns <= columns && canPlace(item, column, row, occupied, columns)) {
      return { column, row };
    }
  }
}

export function packDashboardLayoutItems(
  items: readonly CandidateItem[],
  columns = DASHBOARD_LAYOUT_COLUMNS,
  preservePreferredPositions = true
): DashboardLayoutItem[] {
  const safeColumns = Math.max(2, Math.floor(columns));
  const occupied = new Set<string>();
  const packed: DashboardLayoutItem[] = [];
  for (const candidate of items) {
    const preferredColumn = preservePreferredPositions && isGridCoordinate(candidate.column)
      ? candidate.column
      : -1;
    const preferredRow = preservePreferredPositions && isGridCoordinate(candidate.row)
      ? candidate.row
      : -1;
    const position = canPlace(candidate, preferredColumn, preferredRow, occupied, safeColumns)
      ? { column: preferredColumn, row: preferredRow }
      : firstFit(candidate, occupied, safeColumns);
    const item: DashboardLayoutItem = { ...candidate, ...position };
    packed.push(item);
    for (const cell of cellsFor(item)) occupied.add(cell);
  }
  return packed;
}

export function projectDashboardFrameTargetToStoredCell(
  items: readonly DashboardLayoutItem[],
  widgetId: DashboardWidgetId,
  frameColumns: number,
  column: number,
  row: number
): { column: number; row: number } {
  if (frameColumns === DASHBOARD_LAYOUT_COLUMNS) {
    return { column, row };
  }
  const safeColumns = Math.max(2, Math.floor(frameColumns));
  const frameItems = packDashboardLayoutItems(items, safeColumns, false);
  const target = frameItems.find((item) => {
    if (item.widget_id === widgetId) return false;
    const footprint = getDashboardWidgetFootprint(item.size);
    return column >= item.column
      && column < item.column + footprint.columns
      && row >= item.row
      && row < item.row + footprint.rows;
  });
  const orderedCandidates = frameItems
    .filter((item) => item.widget_id !== widgetId)
    .sort((left, right) => (
      left.row - right.row
      || left.column - right.column
      || left.widget_id.localeCompare(right.widget_id)
    ));
  const targetIndex = row * safeColumns + column;
  const nearest = target ?? orderedCandidates.find((item) => (
    item.row * safeColumns + item.column >= targetIndex
  )) ?? orderedCandidates.at(-1);
  const stored = nearest
    ? items.find((item) => item.widget_id === nearest.widget_id)
    : items.find((item) => item.widget_id === widgetId);
  return stored ? { column: stored.column, row: stored.row } : { column, row };
}

function sortSpatially(items: readonly DashboardLayoutItem[]): DashboardLayoutItem[] {
  return items.map((item) => ({ ...item })).sort((left, right) => (
    left.row - right.row
    || left.column - right.column
    || left.widget_id.localeCompare(right.widget_id)
  ));
}

function reflowPrioritizing(
  items: readonly DashboardLayoutItem[],
  priorityId: DashboardWidgetId,
  preferred: { column: number; row: number; size?: DashboardWidgetSize },
  stableOrder?: readonly DashboardWidgetId[]
): DashboardLayoutItem[] {
  const fixed = items.find((item) => DASHBOARD_WIDGET_BY_ID.get(item.widget_id)?.fixed);
  const priority = items.find((item) => item.widget_id === priorityId);
  if (!priority || DASHBOARD_WIDGET_BY_ID.get(priorityId)?.fixed) {
    return items.map((item) => ({ ...item }));
  }
  const nextPriority = {
    ...priority,
    size: preferred.size ?? priority.size,
    column: Math.max(0, Math.floor(preferred.column)),
    row: Math.max(0, Math.floor(preferred.row)),
  };
  const footprint = getDashboardWidgetFootprint(nextPriority.size);
  nextPriority.column = Math.min(nextPriority.column, DASHBOARD_LAYOUT_COLUMNS - footprint.columns);
  nextPriority.row = Math.min(nextPriority.row, DASHBOARD_LAYOUT_MAX_ROWS - footprint.rows);

  const occupied = new Set<string>();
  const placed: DashboardLayoutItem[] = [];
  if (fixed) {
    const fixedItem = { ...fixed, column: 0, row: 0 };
    placed.push(fixedItem);
    for (const cell of cellsFor(fixedItem)) occupied.add(cell);
  }
  const priorityPosition = canPlace(nextPriority, nextPriority.column, nextPriority.row, occupied, DASHBOARD_LAYOUT_COLUMNS)
    ? { column: nextPriority.column, row: nextPriority.row }
    : firstFit(
      nextPriority,
      occupied,
      DASHBOARD_LAYOUT_COLUMNS,
      nextPriority.row * DASHBOARD_LAYOUT_COLUMNS + nextPriority.column
    );
  const moved = { ...nextPriority, ...priorityPosition };
  placed.push(moved);
  for (const cell of cellsFor(moved)) occupied.add(cell);

  const byId = new Map(items.map((item) => [item.widget_id, item]));
  const orderedItems = stableOrder
    ? [
        ...stableOrder.map((widgetId) => byId.get(widgetId)).filter((item): item is DashboardLayoutItem => Boolean(item)),
        ...items.filter((item) => !stableOrder.includes(item.widget_id)),
      ]
    : items;
  for (const item of orderedItems) {
    if (item.widget_id === priorityId || item.widget_id === fixed?.widget_id) continue;
    const position = canPlace(item, item.column, item.row, occupied, DASHBOARD_LAYOUT_COLUMNS)
      ? { column: item.column, row: item.row }
      : firstFit(item, occupied, DASHBOARD_LAYOUT_COLUMNS);
    const reflowed = { ...item, ...position };
    placed.push(reflowed);
    for (const cell of cellsFor(reflowed)) occupied.add(cell);
  }
  return sortSpatially(placed);
}

export function moveDashboardLayoutItem(
  items: readonly DashboardLayoutItem[],
  widgetId: DashboardWidgetId,
  column: number,
  row: number,
  stableOrder?: readonly DashboardWidgetId[]
): DashboardLayoutItem[] {
  return reflowPrioritizing(items, widgetId, { column, row }, stableOrder);
}

export function resizeDashboardLayoutItem(
  items: readonly DashboardLayoutItem[],
  widgetId: DashboardWidgetId,
  size: DashboardWidgetSize
): DashboardLayoutItem[] {
  const item = items.find((candidate) => candidate.widget_id === widgetId);
  const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
  if (!item || !catalog || !catalog.allowedSizes.includes(size)) {
    return items.map((candidate) => ({ ...candidate }));
  }
  return reflowPrioritizing(items, widgetId, { column: item.column, row: item.row, size });
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
  const candidates = DASHBOARD_WIDGET_CATALOG
    .filter((entry) => entry.fixed || (
      normalizedRole !== null && entry.defaultRoles.includes(normalizedRole)
    ))
    .filter((entry) => isDashboardWidgetEntitled(entry, role))
    .map((entry) => ({ widget_id: entry.id, size: entry.defaultSize }));
  return packDashboardLayoutItems(candidates, DASHBOARD_LAYOUT_COLUMNS, false);
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
  if (
    !isObject(value)
    || (value.version !== 1 && value.version !== DASHBOARD_LAYOUT_VERSION)
    || !Array.isArray(value.items)
  ) {
    return fallback;
  }

  const removedWidgetIds = parseRemovedIds(value.removed_widget_ids, role);
  const removed = new Set(removedWidgetIds);
  const seen = new Set<DashboardWidgetId>();
  const candidates: CandidateItem[] = [];

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
    const mappedSize = typeof candidate.size === "string" && LEGACY_SIZE_MAP[candidate.size]
      ? LEGACY_SIZE_MAP[candidate.size]
      : candidate.size;
    const size = isDashboardWidgetSize(mappedSize) && entry.allowedSizes.includes(mappedSize)
      ? mappedSize
      : entry.defaultSize;
    candidates.push({
      widget_id: entry.id,
      size,
      column: value.version === DASHBOARD_LAYOUT_VERSION && isGridCoordinate(candidate.column)
        ? candidate.column
        : undefined,
      row: value.version === DASHBOARD_LAYOUT_VERSION && isDashboardRow(candidate.row, size)
        ? candidate.row
        : undefined,
    });
  }

  const fixedEntry = DASHBOARD_WIDGET_CATALOG.find((entry) => entry.fixed);
  if (fixedEntry) {
    const fixedIndex = candidates.findIndex((item) => item.widget_id === fixedEntry.id);
    if (fixedIndex >= 0) {
      const [fixedItem] = candidates.splice(fixedIndex, 1);
      if (fixedItem) {
        candidates.unshift({ ...fixedItem, size: fixedEntry.defaultSize, column: 0, row: 0 });
      }
    } else {
      candidates.unshift({ widget_id: fixedEntry.id, size: fixedEntry.defaultSize, column: 0, row: 0 });
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
      candidates.push({ widget_id: entry.id, size: entry.defaultSize });
    }
  }

  const items = sortSpatially(packDashboardLayoutItems(candidates));

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
    if (
      !isObject(parsed)
      || (parsed.version !== 1 && parsed.version !== DASHBOARD_LAYOUT_VERSION)
      || !Array.isArray(parsed.items)
    ) {
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
