import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    { source: "/login", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/signup", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/onboarding/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    {
      source: "/account-archived/:path*",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
    {
      source: "/subscription-required/:path*",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
    { source: "/dashboard/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/students/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/leads/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/schedule/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/belt-tracker/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/reports/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/settings/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/billing/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/automations/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/account/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/help/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
  ],
};
