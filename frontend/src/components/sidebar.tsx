"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./logo";
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
}

export function Sidebar({ userEmail, userName, onSignOut }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-[240px] bg-surface border-r border-border flex flex-col z-30">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border">
        <Logo size="md" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-3 overflow-y-auto">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = iconMap[item.icon];
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`
                    flex items-center gap-3 px-3 py-2 rounded-[6px] text-sm
                    transition-all duration-150 group relative
                    ${
                      isActive
                        ? "bg-surface-raised text-text-primary"
                        : "text-text-secondary hover:text-text-primary hover:bg-surface-raised"
                    }
                  `}
                >
                  {/* Active indicator bar */}
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-accent" />
                  )}
                  {Icon && (
                    <Icon
                      className={`w-4 h-4 flex-shrink-0 ${
                        isActive ? "text-accent" : "text-muted group-hover:text-text-secondary"
                      }`}
                    />
                  )}
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User section */}
      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center gap-3 px-3 py-2">
          {/* Avatar */}
          <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-medium text-accent">
              {(userName || userEmail || "U")[0].toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-primary truncate">
              {userName || "User"}
            </p>
            <p className="text-xs text-muted truncate">{userEmail}</p>
          </div>
          <button
            onClick={onSignOut}
            className="text-muted hover:text-text-secondary transition-colors p-1 cursor-pointer"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
