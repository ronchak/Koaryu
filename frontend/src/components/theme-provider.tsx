"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "koaryu-theme";
const DEFAULT_THEME: ThemePreference = "system";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    return DEFAULT_THEME;
  }

  return DEFAULT_THEME;
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }

  return "dark";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

function applyTheme(preference: ThemePreference, animate = false): ResolvedTheme {
  const resolvedTheme = resolveTheme(preference);
  const root = document.documentElement;

  if (animate) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 320);
  }

  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;

  return resolvedTheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

  const setTheme = useCallback((nextPreference: ThemePreference) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, nextPreference);
    } catch {
      // Theme preference is progressive enhancement; the DOM theme still updates.
    }

    setPreferenceState(nextPreference);
    setResolvedTheme(applyTheme(nextPreference, true));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const syncTimer = window.setTimeout(() => {
      const initialPreference = getStoredPreference();

      setPreferenceState(initialPreference);
      setResolvedTheme(applyTheme(initialPreference));
    }, 0);

    function handleSystemChange() {
      const currentPreference = getStoredPreference();
      if (currentPreference === "system") {
        setResolvedTheme(applyTheme(currentPreference));
      }
    }

    function handleStorageChange(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;

      const nextPreference = getStoredPreference();
      setPreferenceState(nextPreference);
      setResolvedTheme(applyTheme(nextPreference));
    }

    media.addEventListener("change", handleSystemChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.clearTimeout(syncTimer);
      media.removeEventListener("change", handleSystemChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      setTheme,
      toggleTheme,
    }),
    [preference, resolvedTheme, setTheme, toggleTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }

  return context;
}
