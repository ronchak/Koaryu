"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/logo";
import { APP_TAGLINE } from "@/lib/constants";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { clearActiveStudioIdCookie, setActiveStudioIdCookie, setStudioStateCookie } from "@/lib/studio-state-cookie";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      return;
    }

    let cancelled = false;

    async function redirectAuthenticatedUser() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session || cancelled) {
        return;
      }

      try {
        const authProfile = await api.get<{ studio_id: string | null }>(
          "/auth/me",
          session.access_token,
          { omitStudioHeader: true }
        );

        if (cancelled) {
          return;
        }

        const hasStudio = Boolean(authProfile.studio_id);
        setStudioStateCookie(session.user.id, hasStudio);
        if (authProfile.studio_id) {
          setActiveStudioIdCookie(authProfile.studio_id);
        } else {
          clearActiveStudioIdCookie();
        }
        router.replace(hasStudio ? "/dashboard" : "/onboarding");
        router.refresh();
      } catch {
        // Keep the auth page mounted if studio lookup fails.
        // The middleware no longer hard-redirects auth routes, so this avoids loops.
      }
    }

    void redirectAuthenticatedUser();

    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-bg">
      {/* Subtle top gradient line */}
      <div className="fixed top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

      <div className="w-full max-w-[380px] flex flex-col items-center">
        {/* Logo and tagline */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-3">
            <Logo size="lg" />
          </div>
          <p className="text-sm text-muted">{APP_TAGLINE}</p>
        </div>

        {/* Auth card */}
        <div className="w-full bg-surface border border-border rounded-[6px] p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
