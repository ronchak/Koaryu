"use client";

import { Check, Languages, Moon, Palette, Sun } from "lucide-react";
import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { useTheme, type ThemePreference } from "@/components/theme-provider";

function labelTheme(value: ThemePreference) {
  if (value === "dark") return "Dark";
  if (value === "light") return "Light";
  return "System";
}

export default function PersonalizationPage() {
  const { preference, resolvedTheme, setTheme } = useTheme();

  return (
    <AccountPageShell
      title="Personalization"
      description="Tune Koaryu for the way you prefer to work."
    >
      <AccountSection
        title="Appearance"
        description="Theme preference applies immediately and follows you across browser tabs on this device."
      >
        <div id="appearance" className="grid gap-3 sm:grid-cols-3">
          {(["system", "dark", "light"] as ThemePreference[]).map((theme) => {
            const selected = preference === theme;
            const Icon = theme === "light" ? Sun : Moon;
            return (
              <button
                key={theme}
                type="button"
                aria-pressed={selected}
                onClick={() => setTheme(theme)}
                className={`rounded-[6px] border p-4 text-left transition-colors ${
                  selected ? "border-accent bg-accent/10" : "border-border bg-surface-raised hover:bg-surface-hover"
                }`}
              >
                <span className="mb-3 flex items-center justify-between">
                  <Icon className="h-4 w-4 text-accent" />
                  {selected && <Check className="h-4 w-4 text-accent" />}
                </span>
                <span className="block text-sm font-medium text-text-primary">{labelTheme(theme)}</span>
                <span className="mt-1 block text-xs text-muted">
                  {theme === "system" ? "Use your device setting." : `Always use ${labelTheme(theme).toLowerCase()} mode.`}
                </span>
              </button>
            );
          })}
        </div>
      </AccountSection>

      <AccountSection title="Workspace feel">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled
          >
            Comfortable
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled
          >
            Compact
          </Button>
        </div>
        <div className="mt-4">
          <AccountInfoRow
            label="Current theme"
            value={`${labelTheme(preference)} (${resolvedTheme})`}
            detail="Stored in this browser/device."
          />
          <AccountInfoRow
            label="Density"
            value="Planned"
            detail="Compact and comfortable density controls will become active when the layout system consumes them."
          />
        </div>
      </AccountSection>

      <AccountSection
        title="Language"
        description="Koaryu is currently English-first. Language switching is planned for a later localization pass."
      >
        <div id="language" className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled
            className="rounded-[6px] border border-accent bg-accent/10 p-4 text-left opacity-80"
          >
            <Palette className="mb-3 h-4 w-4 text-accent" />
            <span className="block text-sm font-medium text-text-primary">Default</span>
            <span className="mt-1 block text-xs text-muted">Koaryu currently uses the default English interface.</span>
          </button>
          <button
            type="button"
            disabled
            className="rounded-[6px] border border-border bg-surface-raised p-4 text-left opacity-60"
          >
            <Languages className="mb-3 h-4 w-4 text-accent" />
            <span className="block text-sm font-medium text-text-primary">English (US)</span>
            <span className="mt-1 block text-xs text-muted">Language switching is planned for a later localization pass.</span>
          </button>
        </div>
      </AccountSection>

      <AccountSection title="What this affects">
        <AccountNotice>
          Theme is active today and stored in this browser/device. Density and language are visible here as planned
          account settings so users know where those controls will live once implemented.
        </AccountNotice>
      </AccountSection>
    </AccountPageShell>
  );
}
