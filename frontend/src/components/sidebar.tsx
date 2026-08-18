"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Award,
  BarChart3,
  Calendar,
  CreditCard,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserPlus,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AccountMenu } from "@/components/account-menu";
import { Logo } from "./logo";
import { NAV_ITEMS } from "@/lib/constants";
import styles from "./dashboard-shell.module.css";

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  studioName?: string;
  role?: string | null;
  onSignOut?: () => void;
  isSigningOut?: boolean;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

const NAV_ICONS: Record<string, LucideIcon> = {
  Award,
  BarChart3,
  Calendar,
  CreditCard,
  LayoutDashboard,
  Settings,
  UserPlus,
  Users,
  Zap,
};

function NavigationLinks({ pathname }: { pathname: string }) {
  return NAV_ITEMS.map((item) => {
    const isActive = isActiveRoute(pathname, item.href);
    const Icon = NAV_ICONS[item.icon] ?? LayoutDashboard;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          prefetch={item.prefetch}
          aria-current={isActive ? "page" : undefined}
          aria-label={item.label}
          title={item.label}
          className={styles.navLink}
        >
          <Icon className={styles.navIcon} aria-hidden="true" size={17} strokeWidth={1.8} />
          <span className={styles.navLabel}>{item.label}</span>
        </Link>
      </li>
    );
  });
}

export function Sidebar({
  userEmail,
  userName,
  studioName,
  role,
  onSignOut,
  isSigningOut = false,
  isCollapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const pathname = usePathname();
  const displayName = userName || "User";
  const ToggleIcon = isCollapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = isCollapsed ? "Expand product spine" : "Collapse product spine";

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
            <NavigationLinks pathname={pathname} />
          </ul>
        </nav>
      </div>

      <aside className={styles.spine} data-collapsed={isCollapsed ? "true" : "false"}>
        <div className={styles.brandBand}>
          <Link href="/" aria-label="Go to Koaryu homepage" className={styles.brandLink}>
            <Logo size="md" showText={!isCollapsed} />
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
              <ToggleIcon aria-hidden="true" size={18} />
            </button>
          ) : null}
        </div>
        <nav className={styles.spineNav} aria-label="Product navigation">
          <ul className={styles.spineList}>
            {isCollapsed && onToggleCollapsed ? (
              <li>
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label={toggleLabel}
                  aria-expanded={false}
                  title={toggleLabel}
                  className={styles.spineToggle}
                >
                  <ToggleIcon aria-hidden="true" size={18} />
                </button>
              </li>
            ) : null}
            <NavigationLinks pathname={pathname} />
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
    </>
  );
}
