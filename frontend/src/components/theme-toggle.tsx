"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";

interface ThemeToggleProps {
  className?: string;
  compact?: boolean;
}

export function ThemeToggle({ className = "", compact = false }: ThemeToggleProps) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={`
        inline-flex flex-shrink-0 cursor-pointer items-center justify-center rounded-[6px]
        text-muted transition-[background-color,color,border-color] duration-150 ease-out
        hover:bg-surface-raised hover:text-text-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
        focus-visible:ring-offset-surface motion-reduce:transition-none
        ${compact ? "h-7 w-7" : "h-8 w-8"}
        ${className}
      `}
    >
      <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
    </button>
  );
}
