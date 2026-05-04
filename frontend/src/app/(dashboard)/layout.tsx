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
  const { studioName, userEmail, userName } = useStudioStore();

  async function handleSignOut() {
    clearStudioStateCookie();
    clearActiveStudioIdCookie();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen">
      <Sidebar
        userEmail={userEmail}
        userName={userName || studioName || "Koaryu"}
        onSignOut={handleSignOut}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapsed={() => setIsSidebarCollapsed((current) => !current)}
      />
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
