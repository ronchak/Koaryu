"use client";

import { Check, Languages, LayoutPanelLeft, LayoutPanelTop, Moon, Palette, Sun } from "lucide-react";
import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import {
  useTheme,
  type NavigationPlacement,
  type ThemePreference,
} from "@/components/theme-provider";

function labelTheme(value: ThemePreference) {
  if (value === "dark") return "Dark";
  if (value === "light") return "Light";
  return "System";
}

function labelNavigationPlacement(value: NavigationPlacement) {
  return value === "top" ? "Top command bar" : "Side rail";
}

export default function PersonalizationPage() {
  const {
    navigationPlacement,
    preference,
    resolvedTheme,
    setNavigationPlacement,
    setTheme,
  } = useTheme();

  return (
    <AccountPageShell
      title="Personalization"
      description="Tune Koaryu for the way you prefer to work."
    >
      <AccountSection
        title="Appearance"
        description="Theme and navigation preferences apply immediately and stay consistent across browser tabs on this device."
      >
        <div id="appearance" className="space-y-6">
          <div role="group" aria-labelledby="theme-preference-label">
            <p id="theme-preference-label" className="mb-2 text-sm font-medium text-text-primary">Theme</p>
            <div className="grid border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
              {(["system", "dark", "light"] as ThemePreference[]).map((theme) => {
                const selected = preference === theme;
                const Icon = theme === "light" ? Sun : Moon;
                return (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTheme(theme)}
                    className={`min-h-32 border-b border-border p-4 text-left transition-colors last:border-b-0 sm:border-b-0 ${
                      selected ? "bg-accent/10" : "bg-surface hover:bg-surface-raised"
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
          </div>

          <div role="group" aria-labelledby="navigation-preference-label">
            <p id="navigation-preference-label" className="mb-2 text-sm font-medium text-text-primary">Navigation</p>
            <div className="grid border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-border">
              {(["side", "top"] as NavigationPlacement[]).map((placement) => {
                const selected = navigationPlacement === placement;
                const Icon = placement === "side" ? LayoutPanelLeft : LayoutPanelTop;
                return (
                  <button
                    key={placement}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setNavigationPlacement(placement)}
                    className={`min-h-28 border-b border-border p-4 text-left transition-colors last:border-b-0 sm:border-b-0 ${
                      selected ? "bg-accent/10" : "bg-surface hover:bg-surface-raised"
                    }`}
                  >
                    <span className="mb-3 flex items-center justify-between">
                      <Icon className="h-4 w-4 text-accent" />
                      {selected && <Check className="h-4 w-4 text-accent" />}
                    </span>
                    <span className="block text-sm font-medium text-text-primary">
                      {labelNavigationPlacement(placement)}
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      {placement === "side"
                        ? "Keep navigation in a collapsible desktop rail."
                        : "Move navigation into a horizontal desktop bar."}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </AccountSection>

      <AccountSection title="Workspace feel">
        <div>
          <AccountInfoRow
            label="Current theme"
            value={`${labelTheme(preference)} (${resolvedTheme})`}
            detail="Stored in this browser/device."
          />
          <AccountInfoRow
            label="Current navigation"
            value={labelNavigationPlacement(navigationPlacement)}
            detail="Stored in this browser/device. Mobile navigation keeps its compact layout."
          />
          <AccountInfoRow
            label="Current density"
            value="Comfortable"
            detail="Compact density is planned, but no density preference is active today."
          />
        </div>
      </AccountSection>

      <AccountSection
        title="Language"
        description="Koaryu is currently English-first. Language switching is planned for a later localization pass."
      >
        <div id="language" className="grid border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-border">
          <div
            aria-current="true"
            className="border-b border-border bg-accent/10 p-4 text-left opacity-80 sm:border-b-0"
          >
            <Palette className="mb-3 h-4 w-4 text-accent" />
            <span className="block text-sm font-medium text-text-primary">Default</span>
            <span className="mt-1 block text-xs text-muted">Koaryu currently uses the default English interface.</span>
          </div>
          <div
            className="bg-surface-raised p-4 text-left opacity-60"
          >
            <Languages className="mb-3 h-4 w-4 text-accent" />
            <span className="block text-sm font-medium text-text-primary">English (US)</span>
            <span className="mt-1 block text-xs text-muted">Language switching is planned for a later localization pass.</span>
          </div>
        </div>
      </AccountSection>

      <AccountSection title="What this affects">
        <AccountNotice>
          Theme and desktop navigation are active today and stored in this browser/device. Density and language
          are shown as read-only account settings until those preferences are implemented.
        </AccountNotice>
      </AccountSection>
    </AccountPageShell>
  );
}
