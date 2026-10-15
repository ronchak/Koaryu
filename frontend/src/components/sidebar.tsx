"use client";

import Link from "next/link";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  LayoutDashboard,
  Settings,
  UserPlus,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { AccountMenu } from "@/components/account-menu";
import { NavigationPending } from "@/components/navigation-pending";
import { MartialArtsBelt } from "@/components/icons/martial-arts-belt";
import type { NavigationPlacement } from "@/components/theme-provider";
import { KoaryuMark, Logo } from "./logo";
import { APP_NAME, NAV_ITEMS } from "@/lib/constants";
import { formatDashboardRole } from "@/lib/dashboard-shell-route";
import styles from "./dashboard-shell.module.css";

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  studioName?: string;
  role?: string | null;
  onSignOut?: () => void;
  isSigningOut?: boolean;
  placement?: NavigationPlacement;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

function studioInitials(name: string): string {
  const words = name
    .replace(/['’]s\b/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase();
}

function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

const NAV_ICONS: Record<string, LucideIcon> = {
  BarChart3,
  Calendar,
  CreditCard,
  LayoutDashboard,
  MartialArtsBelt,
  Settings,
  UserPlus,
  Users,
  Workflow,
};

function NavigationLinks({
  pathname,
  role,
  collapsed = false,
}: {
  pathname: string;
  role?: string | null;
  collapsed?: boolean;
}) {
  return NAV_ITEMS.filter((item) => role && (!item.roles || item.roles.includes(role))).map(
    (item) => {
      const isActive = isActiveRoute(pathname, item.href);
      const Icon = NAV_ICONS[item.icon] ?? LayoutDashboard;
      return (
        <li key={item.href}>
          <IntentPrefetchLink
            href={item.href}
            data-koaryu-navigation-link="true"
            prefetch={item.prefetch}
            aria-current={isActive ? "page" : undefined}
            aria-label={item.label}
            // The label is visible when expanded; a tooltip then would only repeat it.
            title={collapsed ? item.label : undefined}
            className={styles.navLink}
          >
            <span className={styles.navIconSlot}>
              <Icon className={styles.navIcon} aria-hidden="true" size={17} strokeWidth={1.8} />
              <NavigationPending />
            </span>
            <span className={styles.navLabel}>{item.label}</span>
          </IntentPrefetchLink>
        </li>
      );
    },
  );
}

export function Sidebar({
  userEmail,
  userName,
  studioName,
  role,
  onSignOut,
  isSigningOut = false,
  placement = "side",
  isCollapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const pathname = usePathname();
  const displayName = userName || "User";
  const ToggleIcon = isCollapsed ? ChevronRight : ChevronLeft;
  const toggleLabel = isCollapsed ? "Expand product spine" : "Collapse product spine";
  const roleLabel = formatDashboardRole(role);

  return (
    <>
      <div className={styles.mobileSpine}>
        <div className={styles.mobileTop}>
          <Link href="/" aria-label="Go to Koaryu homepage" className={styles.mobileBrand}>
            <Logo size="sm" />
          </Link>
          <AccountMenu
            userEmail={userEmail}
            userName={displayName}
            studioName={studioName}
            role={role}
            onSignOut={onSignOut}
            isSigningOut={isSigningOut}
            compact
            collapsed
          />
        </div>
        <nav aria-label="Product navigation">
          <ul className={styles.mobileNav}>
            <NavigationLinks pathname={pathname} role={role} />
          </ul>
        </nav>
      </div>

      {placement === "top" ? (
        <header className={styles.commandBar}>
          <Link href="/" aria-label="Go to Koaryu homepage" className={styles.commandBrand}>
            <Logo size="sm" />
          </Link>
          <nav className={styles.commandNav} aria-label="Product navigation">
            <ul className={styles.commandList}>
              <NavigationLinks pathname={pathname} role={role} />
            </ul>
          </nav>
          <div className={styles.commandAccount}>
            <AccountMenu
              userEmail={userEmail}
              userName={displayName}
              studioName={studioName}
              role={role}
              onSignOut={onSignOut}
              isSigningOut={isSigningOut}
              compact
              collapsed
            />
          </div>
        </header>
      ) : (
        /*
         * The spine is one column of 48px slots. Every row (brand, studio, each
         * link, the account trigger) puts its mark in that slot and its words to
         * the right, so collapsing only narrows the rail to the slot: nothing
         * moves, the words fade, and the handle on the edge stays where it was.
         */
        <aside className={styles.spine} data-collapsed={isCollapsed ? "true" : "false"}>
          <div className={styles.brandBand}>
            <Link href="/" aria-label="Go to Koaryu homepage" className={styles.brandLink}>
              <span className={styles.railSlot}>
                <KoaryuMark size="lg" />
              </span>
              <span className={styles.brandWord}>{APP_NAME}</span>
            </Link>
            {onToggleCollapsed ? (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label={toggleLabel}
                aria-expanded={!isCollapsed}
                title={toggleLabel}
                className={styles.spineToggle}
              >
                <ToggleIcon aria-hidden="true" size={14} strokeWidth={2.2} />
              </button>
            ) : null}
          </div>
          {studioName ? (
            <div
              className={styles.studioCard}
              title={isCollapsed ? `${studioName} · ${roleLabel}` : undefined}
            >
              <span className={styles.railSlot}>
                <span className={styles.studioMark} aria-hidden="true">
                  {studioInitials(studioName)}
                </span>
              </span>
              <span className={styles.studioText}>
                <strong>{studioName}</strong>
                <small>{roleLabel}</small>
              </span>
            </div>
          ) : null}
          <nav className={styles.spineNav} aria-label="Product navigation">
            <ul className={styles.spineList}>
              <NavigationLinks pathname={pathname} role={role} collapsed={isCollapsed} />
            </ul>
          </nav>
          <div className={styles.accountBand}>
            <AccountMenu
              userEmail={userEmail}
              userName={displayName}
              studioName={studioName}
              role={role}
              onSignOut={onSignOut}
              isSigningOut={isSigningOut}
              collapsed={isCollapsed}
            />
          </div>
        </aside>
      )}
    </>
  );
}
