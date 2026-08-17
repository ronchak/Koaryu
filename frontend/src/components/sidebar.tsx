"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
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

function NavigationLinks({ pathname }: { pathname: string }) {
  return NAV_ITEMS.map((item, index) => {
    const isActive = isActiveRoute(pathname, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          prefetch={item.prefetch}
          aria-current={isActive ? "page" : undefined}
          aria-label={`${String(index + 1).padStart(2, "0")} ${item.label}`}
          className={styles.navLink}
        >
          <span className={styles.navIndex} aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
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
          <ol className={styles.mobileNav}>
            <NavigationLinks pathname={pathname} />
          </ol>
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
          <ol className={styles.spineList}>
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
          </ol>
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
