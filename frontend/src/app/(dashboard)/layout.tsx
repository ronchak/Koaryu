"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/sidebar";
import { useEffect, useState } from "react";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [userEmail, setUserEmail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function getUser() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          setUserEmail(user.email || "");
          setUserName(user.user_metadata?.full_name || "");
        }
      } catch {
        // Preview mode — no live Supabase connection
        setUserName("Preview Mode");
      }
    }
    getUser();
  }, [supabase]);

  async function handleSignOut() {
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

      {/* Main content area — offset by sidebar width */}
      <main className="flex-1 ml-[240px] flex flex-col min-h-screen">
        {children}
      </main>
    </div>
  );
}
