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
export type NavigationPlacement = "side" | "top";
type ResolvedTheme = "dark" | "light";

const THEME_STORAGE_KEY = "koaryu-theme";
const NAVIGATION_STORAGE_KEY = "koaryu-navigation-placement";
const DEFAULT_THEME: ThemePreference = "light";
const DEFAULT_NAVIGATION_PLACEMENT: NavigationPlacement = "side";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  navigationPlacement: NavigationPlacement;
  setTheme: (theme: ThemePreference) => void;
  setNavigationPlacement: (placement: NavigationPlacement) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    return DEFAULT_THEME;
  }

  return DEFAULT_THEME;
}

function parseNavigationPlacement(value: string | null): NavigationPlacement {
  return value === "side" || value === "top" ? value : DEFAULT_NAVIGATION_PLACEMENT;
}

function getStoredNavigationPlacement(): NavigationPlacement {
  try {
    return parseNavigationPlacement(window.localStorage.getItem(NAVIGATION_STORAGE_KEY));
  } catch {
    return DEFAULT_NAVIGATION_PLACEMENT;
  }
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
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  const [navigationPlacement, setNavigationPlacementState] =
    useState<NavigationPlacement>(DEFAULT_NAVIGATION_PLACEMENT);

  const setTheme = useCallback((nextPreference: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Theme preference is progressive enhancement; the DOM theme still updates.
    }

    setPreferenceState(nextPreference);
    setResolvedTheme(applyTheme(nextPreference, true));
  }, []);

  const setNavigationPlacement = useCallback((nextPlacement: NavigationPlacement) => {
    try {
      window.localStorage.setItem(NAVIGATION_STORAGE_KEY, nextPlacement);
    } catch {
      // Navigation placement still applies for this tab when storage is unavailable.
    }

    setNavigationPlacementState(nextPlacement);
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
      setNavigationPlacementState(getStoredNavigationPlacement());
    }, 0);

    function handleSystemChange() {
      const currentPreference = getStoredPreference();
      if (currentPreference === "system") {
        setResolvedTheme(applyTheme(currentPreference));
      }
    }

    function handleStorageChange(event: StorageEvent) {
      if (event.key === THEME_STORAGE_KEY) {
        const nextPreference =
          event.newValue === "dark" || event.newValue === "light" || event.newValue === "system"
            ? event.newValue
            : DEFAULT_THEME;
        setPreferenceState(nextPreference);
        setResolvedTheme(applyTheme(nextPreference));
        return;
      }

      if (event.key === NAVIGATION_STORAGE_KEY) {
        setNavigationPlacementState(parseNavigationPlacement(event.newValue));
      }
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
      navigationPlacement,
      setTheme,
      setNavigationPlacement,
      toggleTheme,
    }),
    [navigationPlacement, preference, resolvedTheme, setNavigationPlacement, setTheme, toggleTheme]
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
