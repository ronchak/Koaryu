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
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import type { PlatformBillingStatus } from "@/types";

type AccountSubmenu = "help" | "personalization" | null;

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

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  compactLayout: boolean;
}

interface MenuLinkItem {
  href: string;
  label: string;
  icon: LucideIcon;
  subtitle?: string;
  external?: boolean;
}

const MENU_WIDTH = 272;
const SUBMENU_WIDTH = 260;
const MENU_GAP = 8;
const VIEWPORT_GUTTER = 8;
const COMPACT_BREAKPOINT = 640;
const ACTIVE_CORE_STATUSES = new Set(["active", "trialing", "comped"]);

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<AccountSubmenu>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [platformBillingSnapshot, setPlatformBillingSnapshot] = useState<{
    key: string;
    status: PlatformBillingStatus;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const displayName = userName || studioName || "Koaryu account";
  const displayEmail = userEmail || "Account settings";
  const letter = avatarLetter(displayName, userEmail);
  const accountRole = roleLabel(role);
  const canViewSubscription = currentRole === "admin";
  const billingStatusKey = canViewSubscription && !isPreviewMode && token
    ? `${token}:${getActiveStudioIdCookie() || "default"}`
    : null;
  const effectivePlatformBilling =
    billingStatusKey && platformBillingSnapshot?.key === billingStatusKey
      ? platformBillingSnapshot.status
      : null;
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
  const compactLayout = position?.compactLayout ?? false;
  const panelWidth = compactLayout
    ? Math.min(MENU_WIDTH, typeof window === "undefined" ? MENU_WIDTH : window.innerWidth - VIEWPORT_GUTTER * 2)
    : activeSubmenu
      ? MENU_WIDTH + SUBMENU_WIDTH + MENU_GAP
      : MENU_WIDTH;

  const updatePosition = useCallback((nextSubmenu: AccountSubmenu = activeSubmenu) => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;

    const rect = trigger.getBoundingClientRect();
    const isCompactLayout = window.innerWidth < COMPACT_BREAKPOINT;
    const width = isCompactLayout
      ? Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2)
      : nextSubmenu
        ? MENU_WIDTH + SUBMENU_WIDTH + MENU_GAP
        : MENU_WIDTH;
    const maxLeft = window.innerWidth - width - VIEWPORT_GUTTER;
    const left = clamp(rect.left, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, maxLeft));

    if (rect.top > window.innerHeight / 2) {
      const bottom = Math.max(VIEWPORT_GUTTER, window.innerHeight - rect.top + MENU_GAP);
      setPosition({
        left,
        compactLayout: isCompactLayout,
        bottom,
        maxHeight: Math.max(180, window.innerHeight - bottom - VIEWPORT_GUTTER),
      });
      return;
    }

    const top = Math.min(rect.bottom + MENU_GAP, window.innerHeight - VIEWPORT_GUTTER);
    setPosition({
      left,
      compactLayout: isCompactLayout,
      top,
      maxHeight: Math.max(180, window.innerHeight - top - VIEWPORT_GUTTER),
    });
  }, [activeSubmenu]);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setActiveSubmenu(null);
  }, []);

  function openMenu() {
    setIsOpen(true);
    setActiveSubmenu(null);
    window.requestAnimationFrame(() => updatePosition(null));
  }

  function toggleSubmenu(next: AccountSubmenu) {
    const resolved = activeSubmenu === next ? null : next;
    setActiveSubmenu(resolved);
    window.requestAnimationFrame(() => updatePosition(resolved));
  }

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
        triggerRef.current?.focus();
      }
    }

    function handleViewportChange() {
      updatePosition();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const timer = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("a[href], button:not([disabled])")
        ?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSubmenu, isOpen]);

  useEffect(() => {
    if (!isOpen || !billingStatusKey || !token || platformBillingSnapshot?.key === billingStatusKey) {
      return;
    }

    const controller = new AbortController();
    api
      .get<PlatformBillingStatus>("/platform-billing/status", token, {
        signal: controller.signal,
        timeoutMs: 5000,
      })
      .then((status) => setPlatformBillingSnapshot({ key: billingStatusKey, status }))
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
      });

    return () => {
      controller.abort();
    };
  }, [billingStatusKey, isOpen, platformBillingSnapshot?.key, token]);

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

      {isOpen && position && (
        <div
          ref={panelRef}
          className="fixed z-50 flex gap-2 overflow-visible"
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
                  className="flex h-9 w-full items-center gap-2 rounded-[6px] px-2.5 text-sm text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                >
                  <ChevronRight className="h-4 w-4 rotate-180 text-muted" />
                  <span>Account menu</span>
                </button>
              </div>
            )}
            {(!compactLayout || !activeSubmenu) && (
              <>
            <Link
              href="/account"
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
                className="flex h-9 w-full items-center gap-3 rounded-[6px] px-2.5 text-sm text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LogOut className="h-4 w-4 text-muted" />
                <span>{isSigningOut ? "Signing out..." : "Log out"}</span>
              </button>
            </div>
              </>
            )}

            {compactLayout && activeSubmenu === "help" && (
              <div className="p-1.5">
                {helpItems.map((item) => (
                  <MenuLink key={item.href} {...item} onNavigate={closeMenu} />
                ))}
              </div>
            )}

            {compactLayout && activeSubmenu === "personalization" && (
              <PersonalizationPanel
                preference={preference}
                setTheme={setTheme}
                onNavigate={closeMenu}
              />
            )}
          </div>

          {!compactLayout && activeSubmenu && (
            <div
              className="w-[260px] overflow-y-auto rounded-[10px] border border-border bg-surface p-1.5 shadow-2xl shadow-black/30"
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
      onClick={onNavigate}
      className="flex min-h-9 items-center gap-3 rounded-[6px] px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
      </span>
      {external && <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-muted" />}
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
        flex min-h-9 w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-sm
        ${active ? "bg-surface-raised text-text-primary" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"}
      `}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-xs text-muted">{detail}</span>}
      </span>
      <ChevronRight className={`h-4 w-4 flex-shrink-0 text-muted ${active ? "text-text-secondary" : ""}`} />
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
          className="flex h-9 w-full items-center gap-3 rounded-[6px] px-2.5 text-sm text-text-secondary hover:bg-surface-raised hover:text-text-primary"
        >
          <span className="flex h-4 w-4 items-center justify-center text-muted">
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
