import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  // Dev preview mode: bypass auth entirely so mock data pages are accessible
  if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — this will call setAll if the session needs refreshing
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/signup");
  const isOnboardingRoute = pathname.startsWith("/onboarding");
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

  function redirectTo(path: string) {
    const url = request.nextUrl.clone();
    url.pathname = path;
    return NextResponse.redirect(url);
  }

  if (!user) {
    if (isAuthRoute) {
      return supabaseResponse;
    }
    return redirectTo("/login");
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return redirectTo("/login");
  }

  let studioId: string | null = null;

  if (apiBaseUrl) {
    try {
      const authMeResponse = await fetch(`${apiBaseUrl}/auth/me`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      if (authMeResponse.status === 401 || authMeResponse.status === 403) {
        return redirectTo("/login");
      }

      if (!authMeResponse.ok) {
        throw new Error(`/auth/me returned ${authMeResponse.status}`);
      }

      const authProfile = (await authMeResponse.json()) as {
        studio_id?: string | null;
      };

      studioId = authProfile.studio_id ?? null;
    } catch (error) {
      console.error("Failed to resolve current user's studio in middleware", error);
      return supabaseResponse;
    }
  }

  const hasStudio = Boolean(studioId);

  if (isAuthRoute) {
    return redirectTo(hasStudio ? "/" : "/onboarding");
  }

  if (isOnboardingRoute && hasStudio) {
    return redirectTo("/");
  }

  if (!isOnboardingRoute && !hasStudio) {
    return redirectTo("/onboarding");
  }

  return supabaseResponse;
}
