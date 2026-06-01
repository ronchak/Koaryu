"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  ACCOUNT_MENU_CLOSE_DELAY_MS,
  calculateAccountMenuPanelWidth,
  calculateAccountMenuPosition,
  type AccountMenuPosition,
} from "@/lib/account-menu-position";
import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import type { PlatformBillingStatus } from "@/types";

export type AccountSubmenu = "help" | "personalization" | null;

export function useAccountMenuController() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<AccountSubmenu>(null);
  const [position, setPosition] = useState<AccountMenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const submenuPanelRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const updatePosition = useCallback((nextSubmenu: AccountSubmenu = activeSubmenu) => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;

    setPosition(
      calculateAccountMenuPosition({
        triggerRect: trigger.getBoundingClientRect(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hasSubmenu: Boolean(nextSubmenu),
      })
    );
  }, [activeSubmenu]);

  const closeMenu = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(false);
    setActiveSubmenu(null);
    closeTimerRef.current = window.setTimeout(() => {
      setIsMounted(false);
      setPosition(null);
      closeTimerRef.current = null;
    }, ACCOUNT_MENU_CLOSE_DELAY_MS);
  }, []);

  const openMenu = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsMounted(true);
    setIsOpen(true);
    setActiveSubmenu(null);
    window.requestAnimationFrame(() => updatePosition(null));
  }, [updatePosition]);

  const toggleSubmenu = useCallback((next: AccountSubmenu) => {
    const resolved = activeSubmenu === next ? null : next;
    setActiveSubmenu(resolved);
    window.requestAnimationFrame(() => updatePosition(resolved));
  }, [activeSubmenu, updatePosition]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

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
      const focusRoot = activeSubmenu ? submenuPanelRef.current ?? panelRef.current : panelRef.current;
      focusRoot
        ?.querySelector<HTMLElement>("a[href], button:not([disabled])")
        ?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSubmenu, isOpen]);

  const compactLayout = position?.compactLayout ?? false;
  const panelWidth = calculateAccountMenuPanelWidth({
    compactLayout,
    hasSubmenu: Boolean(activeSubmenu),
    viewportWidth: typeof window === "undefined" ? undefined : window.innerWidth,
  });

  return {
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
  };
}

export function useAccountMenuBillingStatus({
  canViewSubscription,
  isPreviewMode,
  isOpen,
  token,
}: {
  canViewSubscription: boolean;
  isPreviewMode: boolean;
  isOpen: boolean;
  token?: string | null;
}) {
  const [platformBillingSnapshot, setPlatformBillingSnapshot] = useState<{
    key: string;
    status: PlatformBillingStatus;
  } | null>(null);
  const billingStatusKey = canViewSubscription && !isPreviewMode && token
    ? `${token}:${getActiveStudioIdCookie() || "default"}`
    : null;

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

  return billingStatusKey && platformBillingSnapshot?.key === billingStatusKey
    ? platformBillingSnapshot.status
    : null;
}
