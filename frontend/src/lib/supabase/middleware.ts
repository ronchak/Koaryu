import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  ACTIVE_STUDIO_COOKIE,
  parseStudioStateCookie,
  serializeStudioStateCookie,
  STUDIO_STATE_COOKIE,
  STUDIO_STATE_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/studio-state-cookie";

function setStudioStateCookie(
  response: NextResponse,
  request: NextRequest,
  userId: string,
  hasStudio: boolean
) {
  response.cookies.set(STUDIO_STATE_COOKIE, serializeStudioStateCookie(userId, hasStudio), {
    path: "/",
    maxAge: STUDIO_STATE_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
}

function clearStudioStateCookie(response: NextResponse, request: NextRequest) {
  response.cookies.set(STUDIO_STATE_COOKIE, "", {
    path: "/",
    maxAge: 0,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
}

function setActiveStudioCookie(
  response: NextResponse,
  request: NextRequest,
  studioId: string
) {
  response.cookies.set(ACTIVE_STUDIO_COOKIE, studioId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
}

function clearActiveStudioCookie(response: NextResponse, request: NextRequest) {
  response.cookies.set(ACTIVE_STUDIO_COOKIE, "", {
    path: "/",
    maxAge: 0,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
}

function copyResponseCookies(source: NextResponse, target: NextResponse) {
  for (const cookie of source.cookies.getAll()) {
    const { name, value, ...options } = cookie;
    target.cookies.set(name, value, options);
  }
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

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

  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/signup");
  const isOnboardingRoute = pathname.startsWith("/onboarding");
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

  function redirectTo(path: string, options?: { clearStudioState?: boolean }) {
    const url = request.nextUrl.clone();
    url.pathname = path;
    const response = NextResponse.redirect(url);
    copyResponseCookies(supabaseResponse, response);
    if (options?.clearStudioState) {
      clearStudioStateCookie(response, request);
      clearActiveStudioCookie(response, request);
    }
    return response;
  }

  if (!user) {
    clearStudioStateCookie(supabaseResponse, request);
    clearActiveStudioCookie(supabaseResponse, request);
    if (isAuthRoute) {
      return supabaseResponse;
    }
    return redirectTo("/login", { clearStudioState: true });
  }

  if (isAuthRoute) {
    return supabaseResponse;
  }

  const studioStateCookie = parseStudioStateCookie(
    request.cookies.get(STUDIO_STATE_COOKIE)?.value
  );
  let hasStudio: boolean | null =
    studioStateCookie?.userId === user.id ? studioStateCookie.hasStudio : null;

  if (hasStudio === null && apiBaseUrl) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return redirectTo("/login", { clearStudioState: true });
    }

    try {
      const authMeResponse = await fetch(`${apiBaseUrl}/auth/me`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      if (authMeResponse.status === 401 || authMeResponse.status === 403) {
        return redirectTo("/login", { clearStudioState: true });
      }

      if (!authMeResponse.ok) {
        throw new Error(`/auth/me returned ${authMeResponse.status}`);
      }

      const authProfile = (await authMeResponse.json()) as {
        studio_id?: string | null;
      };

      hasStudio = Boolean(authProfile.studio_id);
      setStudioStateCookie(supabaseResponse, request, user.id, hasStudio);
      if (authProfile.studio_id) {
        setActiveStudioCookie(supabaseResponse, request, authProfile.studio_id);
      } else {
        clearActiveStudioCookie(supabaseResponse, request);
      }
    } catch (error) {
      console.error("Failed to resolve current user's studio in middleware", error);
      return supabaseResponse;
    }
  }

  if (hasStudio === null) {
    return supabaseResponse;
  }

  if (isOnboardingRoute && hasStudio) {
    return redirectTo("/");
  }

  if (!isOnboardingRoute && !hasStudio) {
    return redirectTo("/onboarding");
  }

  return supabaseResponse;
}
