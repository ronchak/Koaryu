"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearStoredStudioSessionCookies } from "@/lib/store-session-cookies";
import { DashboardRouteTransition } from "@/components/dashboard-route-transition";
import { DashboardSlugBand } from "@/components/dashboard-shell";
import { Sidebar } from "@/components/sidebar";
import { LegalNameBlockingScreen } from "@/components/account/legal-name-blocking-screen";
import { StoreProvider, useConfigStore, useStudioStore } from "@/lib/store";
import { shouldBlockForLegalName } from "@/lib/legal-name-model";
import { useState } from "react";
import styles from "@/components/dashboard-shell.module.css";

function DashboardInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const { isPreviewMode } = useConfigStore();
  const {
    currentRole,
    legalFirstName,
    legalLastName,
    staffProfilesAvailable,
    studioName,
    userEmail,
    userName,
  } = useStudioStore();

  const isLegalNameBlocked = shouldBlockForLegalName({
    staffProfilesAvailable,
    firstName: legalFirstName,
    lastName: legalLastName,
  });

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setSignOutError("");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
      clearStoredStudioSessionCookies();
      router.push("/login");
      router.refresh();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Please try again.");
      setIsSigningOut(false);
    }
  }

  return (
    <div
      className={styles.shellRoot}
      data-koaryu-dashboard-shell="true"
      data-spine-collapsed={isSidebarCollapsed ? "true" : "false"}
    >
      <a href="#main-content" className={styles.skipLink}>Skip to main content</a>
      {signOutError && (
        <div className="fixed bottom-4 left-1/2 z-[70] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 rounded-[6px] border border-danger/25 bg-surface px-4 py-3 text-sm text-text-primary shadow-2xl shadow-black/30">
          <div className="flex items-start justify-between gap-3">
            <p>{signOutError}</p>
            <button
              type="button"
              onClick={() => setSignOutError("")}
              className="text-xs font-medium text-accent hover:text-accent-hover"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {isLegalNameBlocked ? (
        <LegalNameBlockingScreen onSignOut={handleSignOut} isSigningOut={isSigningOut} />
      ) : (
        <>
          <Sidebar
            userEmail={userEmail}
            userName={userName || studioName || "Koaryu"}
            studioName={studioName}
            role={currentRole}
            onSignOut={handleSignOut}
            isSigningOut={isSigningOut}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed((current) => !current)}
          />
          <main
            id="main-content"
            tabIndex={-1}
            className={styles.main}
          >
            <DashboardSlugBand
              isPreviewMode={isPreviewMode}
              role={currentRole}
              studioName={studioName}
            />
            <DashboardRouteTransition>{children}</DashboardRouteTransition>
          </main>
        </>
      )}
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StoreProvider>
      <DashboardInner>{children}</DashboardInner>
    </StoreProvider>
  );
}
