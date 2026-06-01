"use client";

import Link from "next/link";
import {
  AppWindow,
  Bell,
  Bug,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileText,
  Flag,
  Languages,
  LayoutList,
  LogOut,
  Moon,
  Palette,
  Settings,
  Shield,
  Sparkles,
  Sun,
  UserCircle,
  type LucideIcon,
} from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import { crmLinkPrefetch } from "@/lib/constants";
import { useConfigStore } from "@/lib/store";
import type { PlatformBillingStatus } from "@/types";
import styles from "./account-menu.module.css";
import {
  useAccountMenuBillingStatus,
  useAccountMenuController,
  type AccountSubmenu,
} from "./account-menu-state";

interface AccountMenuProps {
  userEmail?: string;
  userName?: string;
  studioName?: string;
  role?: string | null;
  onSignOut?: () => void;
  isSigningOut?: boolean;
  collapsed?: boolean;
  compact?: boolean;
}

interface MenuLinkItem {
  href: string;
  label: string;
  icon: LucideIcon;
  subtitle?: string;
  external?: boolean;
}

const ACTIVE_CORE_STATUSES = new Set(["active", "trialing", "comped"]);
const submenuTitles: Record<Exclude<AccountSubmenu, null>, string> = {
  help: "Help",
  personalization: "Personalization",
};

const helpItems: MenuLinkItem[] = [
  { href: "/help", label: "Help center", icon: CircleHelp },
  { href: "/help/release-notes", label: "Release notes", icon: Flag },
  { href: "/help/downloads", label: "Download apps", icon: AppWindow },
  { href: "/terms", label: "Terms of Service", icon: FileText },
  { href: "/privacy", label: "Privacy Policy", icon: Shield },
  { href: "/help/contact?topic=bug#bug", label: "Report a bug", icon: Bug },
];

const personalizationItems: MenuLinkItem[] = [
  { href: "/account/personalization#appearance", label: "Appearance", icon: Palette },
  { href: "/account/personalization#language", label: "Language", icon: Languages, subtitle: "Default" },
  { href: "/account/notifications", label: "Notifications", icon: Bell },
  { href: "/account/data", label: "Data and export", icon: LayoutList },
];

function roleLabel(role?: string | null): string {
  if (role === "admin") return "Admin";
  if (role === "instructor") return "Instructor";
  if (role === "front_desk") return "Front desk";
  return "Member";
}

function avatarLetter(name?: string, email?: string): string {
  return (name || email || "K").trim().charAt(0).toUpperCase() || "K";
}

function formatTheme(preference: ThemePreference): string {
  if (preference === "dark") return "Dark";
  if (preference === "light") return "Light";
  return "System";
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") return <Sun className="h-4 w-4" />;
  return <Moon className="h-4 w-4" />;
}

function billingLabel(status: PlatformBillingStatus | null, canViewSubscription: boolean) {
  if (!canViewSubscription) {
    return { label: "Billing", subtitle: "Studio payment workspace" };
  }

  if (status && (status.comped || ACTIVE_CORE_STATUSES.has(status.status))) {
    return { label: "Koaryu Core active", subtitle: "See billing information" };
  }

  return { label: status ? "Upgrade plan" : "Billing", subtitle: status ? undefined : "See subscription options" };
}

export function AccountMenu({
  userEmail,
  userName,
  studioName,
  role,
  onSignOut,
  isSigningOut = false,
  collapsed = false,
  compact = false,
}: AccountMenuProps) {
  const { preference, setTheme } = useTheme();
  const { currentRole, isPreviewMode, token } = useConfigStore();
  const {
    activeSubmenu,
    closeMenu,
    compactLayout,
    isMounted,
    isOpen,
    openMenu,
    panelRef,
    panelWidth,
    position,
    submenuPanelRef,
    toggleSubmenu,
    triggerRef,
  } = useAccountMenuController();
  const displayName = userName || studioName || "Koaryu account";
  const displayEmail = userEmail || "Account settings";
  const letter = avatarLetter(displayName, userEmail);
  const accountRole = roleLabel(role);
  const canViewSubscription = currentRole === "admin";
  const effectivePlatformBilling = useAccountMenuBillingStatus({
    canViewSubscription,
    isPreviewMode,
    isOpen,
    token,
  });
  const billingCopy = billingLabel(
    isPreviewMode
      ? {
          studio_id: "preview",
          plan_name: "Koaryu Core",
          monthly_price_cents: 2700,
          currency: "usd",
          status: "comped",
          comped: true,
          cancel_at_period_end: false,
          email_usage: {
            included: 500,
            sent: 0,
            overage_count: 0,
            overage_rate_cents: 0.2,
            estimated_overage_cents: 0,
            period_start: "",
            period_end: "",
          },
        }
      : effectivePlatformBilling,
    canViewSubscription
  );

  const triggerClasses = compact
    ? "inline-flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    : `
        flex w-full cursor-pointer items-center rounded-[6px] text-left transition-[background-color,color,border-color] duration-150 ease-out
        hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
        focus-visible:ring-offset-surface motion-reduce:transition-none
        ${collapsed ? "h-9 justify-center px-0" : "h-11 gap-3 px-3"}
      `;

  return (
    <div className={compact ? "relative" : "w-full"}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        aria-expanded={isOpen}
        aria-label="Open account menu"
        className={triggerClasses}
        title={collapsed ? displayName : undefined}
      >
        <span
          className={`
            flex flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-medium text-accent
            ${collapsed ? "h-8 w-8" : compact ? "h-7 w-7" : "h-7 w-7"}
          `}
          aria-hidden="true"
        >
          {letter}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate text-sm text-text-primary">{displayName}</span>
              <span className="block truncate text-xs text-muted">{displayEmail}</span>
            </span>
            <ChevronRight
              className={`h-4 w-4 flex-shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          </>
        )}
      </button>

      {isMounted && position && (
        <div
          ref={panelRef}
          data-state={isOpen ? "open" : "closed"}
          data-placement={position.bottom ? "top" : "bottom"}
          className={`${styles.root} fixed z-50 flex gap-2 overflow-visible`}
          style={{
            left: position.left,
            top: position.top,
            bottom: position.bottom,
            width: panelWidth,
            maxHeight: position.maxHeight,
          }}
        >
          <div
            className="w-full overflow-y-auto rounded-[10px] border border-border bg-surface shadow-2xl shadow-black/30 sm:w-[272px]"
            style={{ maxHeight: position.maxHeight }}
          >
            {compactLayout && activeSubmenu && (
              <div className="border-b border-border p-1.5">
                <button
                  type="button"
                  onClick={() => toggleSubmenu(null)}
                  aria-label={`Back to account menu from ${submenuTitles[activeSubmenu]}`}
                  className="group flex h-9 w-full items-center gap-2 rounded-[6px] px-2.5 text-sm text-text-secondary transition-[background-color,color,transform] duration-[180ms] ease-out hover:-translate-y-0.5 hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none"
                >
                  <ChevronRight className="h-4 w-4 rotate-180 text-muted transition-transform duration-[180ms] ease-out group-hover:-translate-x-0.5 motion-reduce:transition-none" />
                  <span className="text-xs text-muted">Back</span>
                  <span className="min-w-0 truncate text-text-primary">{submenuTitles[activeSubmenu]}</span>
                </button>
              </div>
            )}
            {(!compactLayout || !activeSubmenu) && (
              <>
            <Link
              href="/account"
              prefetch={crmLinkPrefetch("/account")}
              onClick={closeMenu}
              className="flex items-center gap-3 border-b border-border px-3 py-3 hover:bg-surface-raised"
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-sm font-medium text-accent">
                {letter}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text-primary">{displayName}</span>
                <span className="block truncate text-xs text-muted">{displayEmail}</span>
              </span>
              <span className="rounded-[4px] border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                {accountRole}
              </span>
            </Link>

            <div className="p-1.5">
              <MenuLink
                href="/billing"
                icon={Sparkles}
                label={billingCopy.label}
                subtitle={billingCopy.subtitle}
                onNavigate={closeMenu}
              />
              <MenuButton
                icon={Palette}
                label="Personalization"
                detail={formatTheme(preference)}
                active={activeSubmenu === "personalization"}
                expanded={activeSubmenu === "personalization"}
                onClick={() => toggleSubmenu("personalization")}
              />
              <MenuLink href="/account/profile" icon={UserCircle} label="Profile" onNavigate={closeMenu} />
              <MenuLink href="/account/settings" icon={Settings} label="Account settings" onNavigate={closeMenu} />
            </div>

            <div className="border-t border-border p-1.5">
              <MenuButton
                icon={CircleHelp}
                label="Help"
                active={activeSubmenu === "help"}
                expanded={activeSubmenu === "help"}
                onClick={() => toggleSubmenu("help")}
              />
              <button
                type="button"
                disabled={isSigningOut}
                onClick={() => {
                  if (isSigningOut) return;
                  closeMenu();
                  onSignOut?.();
                }}
                className="group flex h-9 w-full items-center gap-3 rounded-[6px] px-2.5 text-sm text-text-secondary transition-[background-color,color,transform] duration-[180ms] ease-out hover:-translate-y-0.5 hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transition-none"
              >
                <LogOut className="h-4 w-4 text-muted transition-[color,transform] duration-[180ms] ease-out group-hover:-translate-y-0.5 group-hover:text-danger motion-reduce:transition-none" />
                <span>{isSigningOut ? "Signing out..." : "Log out"}</span>
              </button>
            </div>
              </>
            )}

            {compactLayout && activeSubmenu === "help" && (
              <div key="compact-help" className={`${styles.submenuContent} p-1.5`}>
                {helpItems.map((item) => (
                  <MenuLink key={item.href} {...item} onNavigate={closeMenu} />
                ))}
              </div>
            )}

            {compactLayout && activeSubmenu === "personalization" && (
              <div key="compact-personalization" className={styles.submenuContent}>
                <PersonalizationPanel
                  preference={preference}
                  setTheme={setTheme}
                  onNavigate={closeMenu}
                />
              </div>
            )}
          </div>

          {!compactLayout && activeSubmenu && (
            <div
              key={activeSubmenu}
              ref={submenuPanelRef}
              className={`${styles.submenuPanel} w-[260px] overflow-y-auto rounded-[10px] border border-border bg-surface p-1.5 shadow-2xl shadow-black/30`}
              style={{ maxHeight: position.maxHeight }}
            >
              {activeSubmenu === "help" && (
                <>
                  {helpItems.map((item) => (
                    <MenuLink key={item.href} {...item} onNavigate={closeMenu} />
                  ))}
                </>
              )}
              {activeSubmenu === "personalization" && (
                <PersonalizationPanel
                  preference={preference}
                  setTheme={setTheme}
                  onNavigate={closeMenu}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon: Icon,
  label,
  subtitle,
  external,
  onNavigate,
}: MenuLinkItem & { onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      prefetch={external ? false : crmLinkPrefetch(href)}
      onClick={onNavigate}
      className="group flex min-h-9 items-center gap-3 rounded-[6px] px-2.5 py-2 text-sm text-text-secondary transition-[background-color,color,transform] duration-[180ms] ease-out hover:-translate-y-0.5 hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none"
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted transition-[color,transform] duration-[180ms] ease-out group-hover:-translate-y-0.5 group-hover:text-accent motion-reduce:transition-none" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
      </span>
      {external && <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-muted transition-transform duration-[180ms] ease-out group-hover:translate-x-0.5 motion-reduce:transition-none" />}
    </Link>
  );
}

function MenuButton({
  icon: Icon,
  label,
  detail,
  active,
  expanded,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  active?: boolean;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className={`
        group flex min-h-9 w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-sm
        transition-[background-color,color,transform] duration-[180ms] ease-out focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none
        ${active ? "bg-surface-raised text-text-primary" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"}
        hover:-translate-y-0.5
      `}
    >
      <Icon className={`h-4 w-4 flex-shrink-0 text-muted transition-[color,transform] duration-[180ms] ease-out motion-reduce:transition-none ${active ? "text-accent" : "group-hover:text-accent"}`} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-xs text-muted">{detail}</span>}
      </span>
      <ChevronRight
        className={`h-4 w-4 flex-shrink-0 text-muted transition-transform duration-[180ms] ease-out motion-reduce:transition-none ${active ? "text-text-secondary" : ""}`}
        style={{ transform: active ? "rotate(90deg)" : undefined }}
      />
    </button>
  );
}

function PersonalizationPanel({
  preference,
  setTheme,
  onNavigate,
}: {
  preference: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  onNavigate: () => void;
}) {
  return (
    <div className="p-1.5">
      <div className="px-2.5 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        Theme
      </div>
      {(["system", "dark", "light"] as ThemePreference[]).map((theme) => (
        <button
          key={theme}
          type="button"
          aria-pressed={preference === theme}
          onClick={() => setTheme(theme)}
          className="group flex h-9 w-full items-center gap-3 rounded-[6px] px-2.5 text-sm text-text-secondary transition-[background-color,color,transform] duration-[180ms] ease-out hover:-translate-y-0.5 hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none"
        >
          <span className="flex h-4 w-4 items-center justify-center text-muted transition-[color,transform] duration-[180ms] ease-out group-hover:-translate-y-0.5 group-hover:text-accent motion-reduce:transition-none">
            {theme === "system" ? <ThemeIcon preference={preference} /> : <ThemeIcon preference={theme} />}
          </span>
          <span className="flex-1 text-left">{formatTheme(theme)}</span>
          {preference === theme && <Check className="h-3.5 w-3.5 text-accent" />}
        </button>
      ))}
      <div className="my-1.5 border-t border-border" />
      {personalizationItems.map((item) => (
        <MenuLink key={item.href} {...item} onNavigate={onNavigate} />
      ))}
    </div>
  );
}
