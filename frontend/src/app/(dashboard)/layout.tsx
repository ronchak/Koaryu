"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearActiveStudioIdCookie, clearStudioStateCookie } from "@/lib/studio-state-cookie";
import { Sidebar } from "@/components/sidebar";
import { StoreProvider, useStudioStore } from "@/lib/store";
import { useState } from "react";

function DashboardInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const { studioName, userEmail, userName } = useStudioStore();

  async function handleSignOut() {
    clearStudioStateCookie();
    clearActiveStudioIdCookie();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        userEmail={userEmail}
        userName={userName || studioName || "Koaryu"}
        onSignOut={handleSignOut}
      />
      <main className="flex-1 ml-[240px] flex flex-col min-h-screen">
        {children}
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
