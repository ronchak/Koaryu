export const KEYS = {
  students: "koaryu:students",
  leads: "koaryu:leads",
  beltRanks: "koaryu:beltRanks",
  sessions: "koaryu:sessions",
  templates: "koaryu:templates",
  attendance: "koaryu:attendance",
  programs: "koaryu:programs",
  beltLadders: "koaryu:beltLadders",
  studioName: "koaryu:studioName",
  subRankTerm: "koaryu:subRankTerm",
  ladderName: "koaryu:ladderName",
};

export function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

export function save<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function clearPreviewStorage() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("koaryu:")) {
        localStorage.removeItem(key);
      }
    });
  } catch {}
}

export function localId() {
  return `s-${globalThis.crypto.randomUUID()}`;
}
