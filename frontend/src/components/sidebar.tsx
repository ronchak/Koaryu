"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { NAV_ITEMS } from "@/lib/constants";
import {
  LayoutDashboard,
  Users,
  Award,
  UserPlus,
  Calendar,
  CreditCard,
  Zap,
  BarChart3,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  Award,
  UserPlus,
  Calendar,
  CreditCard,
  Zap,
  BarChart3,
  Settings,
};

interface SidebarProps {
  userEmail?: string;
  userName?: string;
  onSignOut?: () => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({
  userEmail,
  userName,
  onSignOut,
  isCollapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const pathname = usePathname();
  const displayName = userName || "User";
  const avatarLetter = (userName || userEmail || "U")[0].toUpperCase();
  const ToggleIcon = isCollapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = isCollapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <>
      <div className="sticky top-0 z-30 border-b border-border bg-surface lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/"
            aria-label="Go to Koaryu homepage"
            className="inline-flex rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Logo size="sm" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-medium text-accent">
              {avatarLetter}
            </span>
            <span className="max-w-32 truncate text-sm text-text-primary">
              {displayName}
            </span>
            <ThemeToggle compact />
            <button
              onClick={onSignOut}
              className="p-1 text-muted transition-colors cursor-pointer hover:text-text-secondary"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        <nav className="grid grid-cols-3 gap-1 px-2 pb-2 sm:grid-cols-5">
          {NAV_ITEMS.map((item) => {
            const Icon = iconMap[item.icon];
            const isActive = pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  flex min-w-0 items-center justify-center gap-1.5 rounded-[6px] px-2 py-2 text-xs
                  transition-[background-color,color,border-color] duration-150
                  ${
                    isActive
                      ? "bg-surface-raised text-text-primary"
                      : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                  }
                `}
              >
                {Icon && (
                  <Icon
                    className={`h-3.5 w-3.5 flex-shrink-0 ${
                      isActive ? "text-accent" : "text-muted"
                    }`}
                  />
                )}
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <aside
        className={`
          fixed left-0 top-0 bottom-0 z-30 hidden flex-col overflow-hidden border-r border-border bg-surface
          transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex
          ${isCollapsed ? "w-[88px]" : "w-[240px]"}
        `}
      >
        {/* Logo */}
        <div
          className={`
            flex items-center border-b border-border
            transition-[height,padding] duration-200 ease-out motion-reduce:transition-none
            ${
              isCollapsed
                ? "h-[76px] justify-center px-4"
                : "h-[73px] justify-between px-5"
            }
          `}
        >
          <Link
            href="/"
            aria-label="Go to Koaryu homepage"
            className="inline-flex min-w-0 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Logo size="md" showText={!isCollapsed} />
          </Link>
          {onToggleCollapsed && !isCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={toggleLabel}
              aria-expanded={!isCollapsed}
              title={toggleLabel}
              className={`
                inline-flex flex-shrink-0 cursor-pointer items-center justify-center text-muted
                transition-[background-color,color,border-color] duration-150 ease-out hover:bg-surface-raised hover:text-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                focus-visible:ring-offset-surface
                ml-3 h-7 w-7 rounded-[6px]
              `}
            >
              <ToggleIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav
          className={`
            flex-1 transition-[padding] duration-200 ease-out motion-reduce:transition-none
            ${isCollapsed ? "overflow-hidden px-6 py-4" : "overflow-y-auto px-3 py-3"}
          `}
        >
          <ul className={isCollapsed ? "space-y-2" : "space-y-0.5"}>
            {onToggleCollapsed && isCollapsed && (
              <li>
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label={toggleLabel}
                  aria-expanded={!isCollapsed}
                  title={toggleLabel}
                  className="
                    group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-[10px] px-0 text-muted
                    transition-[background-color,color,border-color] duration-150 ease-out hover:bg-surface-raised hover:text-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                    focus-visible:ring-offset-surface
                  "
                >
                  <ToggleIcon className="h-[18px] w-[18px]" />
                </button>
              </li>
            )}
            {NAV_ITEMS.map((item) => {
              const Icon = iconMap[item.icon];
              const isActive = pathname.startsWith(item.href);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-label={item.label}
                    title={isCollapsed ? item.label : undefined}
                    className={`
                      group relative flex items-center text-sm
                      transition-[background-color,color,border-color] duration-150 ease-out
                      ${
                        isCollapsed
                          ? "h-10 w-10 justify-center rounded-[10px] px-0"
                          : "h-10 gap-3 rounded-[6px] px-3"
                      }
                      ${
                        isActive
                          ? "bg-surface-raised text-text-primary"
                          : "text-text-secondary hover:text-text-primary hover:bg-surface-raised"
                      }
                    `}
                  >
                    {/* Active indicator bar */}
                    {isActive && (
                      <span
                        className={`
                          absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-accent
                          ${isCollapsed ? "h-5" : "h-4"}
                        `}
                      />
                    )}
                    {Icon && (
                      <Icon
                        className={`${isCollapsed ? "h-[18px] w-[18px]" : "h-4 w-4"} flex-shrink-0 ${
                          isActive ? "text-accent" : "text-muted group-hover:text-text-secondary"
                        }`}
                      />
                    )}
                    <span
                      className={`
                        overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform]
                        duration-150 ease-out motion-reduce:transition-none
                        ${
                          isCollapsed
                            ? "max-w-0 -translate-x-1 opacity-0"
                            : "max-w-36 translate-x-0 opacity-100"
                        }
                      `}
                    >
                      {item.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div
          className={`
            border-t border-border transition-[padding] duration-200 ease-out motion-reduce:transition-none
            ${isCollapsed ? "px-0 py-4" : "px-3 py-3"}
          `}
        >
          <div
            className={`
              flex items-center rounded-[6px] transition-[background-color,color,border-color] duration-150 ease-out
              ${isCollapsed ? "h-9 justify-center px-0" : "h-11 gap-3 px-3"}
            `}
            title={isCollapsed ? displayName : undefined}
          >
            {/* Avatar */}
            <div
              className={`
                rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0
                ${isCollapsed ? "h-8 w-8" : "h-7 w-7"}
              `}
            >
              <span className="text-xs font-medium text-accent">
                {avatarLetter}
              </span>
            </div>
            <div
              className={`
                min-w-0 flex-1 overflow-hidden transition-[max-width,opacity,transform]
                duration-150 ease-out motion-reduce:transition-none
                ${
                  isCollapsed
                    ? "max-w-0 -translate-x-1 opacity-0"
                    : "max-w-36 translate-x-0 opacity-100"
                }
              `}
            >
              <p className="text-sm text-text-primary truncate">
                {displayName}
              </p>
              <p className="text-xs text-muted truncate">{userEmail}</p>
            </div>
            <button
              onClick={onSignOut}
              tabIndex={isCollapsed ? -1 : 0}
              className={`
                cursor-pointer p-1 text-muted transition-[max-width,opacity,color] duration-150 ease-out
                hover:text-text-secondary motion-reduce:transition-none
                ${isCollapsed ? "max-w-0 overflow-hidden opacity-0" : "max-w-7 opacity-100"}
              `}
              title="Sign out"
              aria-hidden={isCollapsed}
            >
              <LogOut className="w-4 h-4" />
            </button>
            {!isCollapsed && <ThemeToggle compact />}
          </div>
          {isCollapsed && (
            <div className="mt-2 flex justify-center">
              <ThemeToggle compact />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
