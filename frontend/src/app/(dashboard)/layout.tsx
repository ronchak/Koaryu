"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearActiveStudioIdCookie, clearStudioStateCookie } from "@/lib/studio-state-cookie";
import { Sidebar } from "@/components/sidebar";
import { StoreProvider, useStudioStore } from "@/lib/store";
import { useEffect, useState } from "react";

function DashboardInner({ children }: { children: React.ReactNode }) {
  const [userEmail, setUserEmail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const { studioName } = useStudioStore();

  useEffect(() => {
    async function getUser() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          setUserEmail(user.email || "");
          setUserName(user.user_metadata?.full_name || "");
        }
      } catch {
        // No live Supabase connection — use studio name
        setUserName(studioName || "Koaryu");
      }
    }
    getUser();
  }, [supabase, studioName]);

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
        userName={userName}
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
