import type { StudentRosterCursorChainEntry } from "@/lib/student-roster-pagination";

const KEYS = ["q", "status", "program", "sort", "dir", "inactiveDays", "newStudents", "fullRoster"] as const;
export function safeStudentsReturn(value: string | null): string {
  if (!value || value.length > 2048 || !/^\/students(?:\?|$)/.test(value)) return "/students";
  const params = new URLSearchParams(value.split("?")[1]);
  const result = new URLSearchParams();
  for (const key of KEYS) {
    const entry = params.get(key);
    if (entry && entry.length <= 200) result.set(key, entry);
  }
  return `/students${result.size ? `?${result}` : ""}`;
}

export type RosterReturnState = {
  scope: string;
  href: string;
  page: number;
  cursor: string | null;
  history: [number, StudentRosterCursorChainEntry][];
  scroll: number;
  focusId: string;
  savedAt: number;
};
const STORAGE_KEY = "koaryu.roster-return.v1";
export function saveRosterReturn(state: RosterReturnState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, history: state.history.slice(-20) }));
  } catch { /* Storage can be disabled. Canonical filters still survive. */ }
}
export function loadRosterReturn(scope: string, href: string): RosterReturnState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 100_000) return null;
    const value = JSON.parse(raw) as RosterReturnState;
    if (value.scope !== scope || value.href !== href || Date.now() - value.savedAt > 30 * 60_000
      || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 100_000
      || !Array.isArray(value.history) || value.history.length > 20
      || !value.history.every((entry) => Array.isArray(entry) && entry.length === 2
        && Number.isSafeInteger(entry[0]) && entry[0] > 0 && entry[1] && typeof entry[1] === "object"
        && Number.isSafeInteger(entry[1].pageOrdinal)
        && [entry[1].nextCursor, entry[1].previousCursor, entry[1].requestCursor]
          .every((cursor) => cursor === null || (typeof cursor === "string" && cursor.length <= 8192)))
      || (value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length > 8192))
      || !Number.isFinite(value.scroll) || value.scroll < 0 || value.scroll > 1_000_000
      || typeof value.focusId !== "string" || value.focusId.length > 100) return null;
    return value;
  } catch { return null; }
}


export function consumeRosterReturn(restored: RosterReturnState): void {
  try {
    const current = loadRosterReturn(restored.scope, restored.href);
    if (current?.savedAt === restored.savedAt) sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Optional return context must not block navigation. */ }
}
