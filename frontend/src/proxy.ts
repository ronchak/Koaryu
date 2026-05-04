import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/login",
    "/signup",
    "/onboarding/:path*",
    "/subscription-required/:path*",
    "/dashboard/:path*",
    "/students/:path*",
    "/leads/:path*",
    "/schedule/:path*",
    "/belt-tracker/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/automations/:path*",
  ],
};
