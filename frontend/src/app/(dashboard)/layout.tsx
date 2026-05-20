"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearActiveStudioIdCookie, clearStudioStateCookie } from "@/lib/studio-state-cookie";
import { DashboardRouteTransition } from "@/components/dashboard-route-transition";
import { Sidebar } from "@/components/sidebar";
import { StoreProvider, useStudioStore } from "@/lib/store";
import { useState } from "react";

function DashboardInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const { currentRole, studioName, userEmail, userName } = useStudioStore();

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setSignOutError("");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
      clearStudioStateCookie();
      clearActiveStudioIdCookie();
      router.push("/login");
      router.refresh();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Please try again.");
      setIsSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen">
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
      <main
        className={`
          flex min-h-screen flex-col transition-[margin-left] duration-200 ease-out motion-reduce:transition-none
          ${isSidebarCollapsed ? "lg:ml-[88px]" : "lg:ml-[240px]"}
        `}
      >
        <DashboardRouteTransition>{children}</DashboardRouteTransition>
      </main>
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
