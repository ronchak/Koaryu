import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  ACTIVE_STUDIO_COOKIE,
  parseStudioStateCookie,
  serializeStudioStateCookie,
  STUDIO_STATE_COOKIE,
  STUDIO_STATE_COOKIE_MAX_AGE_SECONDS,
  type StudioMembershipStatus,
} from "@/lib/studio-state-cookie";
import { canAccessBillingRoute, isBillingRoute } from "@/lib/billing-route-access";
import { ACCOUNT_ARCHIVED_ROUTE, resolveMembershipRoute } from "@/lib/auth-route-model";
import {
  parseAuthProfileResponse,
  type AuthProfileResponse,
} from "@/lib/store-bootstrap-model";

const PUBLIC_STATUS_ROUTES = new Set(["/404", "/500", "/502", "/503", "/504"]);

function setStudioStateCookie(
  response: NextResponse,
  request: NextRequest,
  userId: string,
  hasStudio: boolean,
  membershipStatus: StudioMembershipStatus
) {
  response.cookies.set(
    STUDIO_STATE_COOKIE,
    serializeStudioStateCookie(userId, hasStudio, membershipStatus),
    {
      path: "/",
      maxAge: STUDIO_STATE_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    }
  );
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

  // Keep the informational landing page independent of Supabase and backend
  // cold starts. Login and dashboard routes still run the normal auth gate.
  if (pathname === "/") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/") || PUBLIC_STATUS_ROUTES.has(pathname)) {
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

  const isAuthRoute =
    pathname.startsWith("/login")
    || pathname.startsWith("/signup");
  const isOnboardingRoute = pathname.startsWith("/onboarding");
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  let authProfile: AuthProfileResponse | null = null;
  let membershipStatus: StudioMembershipStatus | null = null;

  function redirectTo(
    path: string,
    options?: {
      clearSearch?: boolean;
      clearActiveStudio?: boolean;
      clearStudioState?: boolean;
    }
  ) {
    const url = request.nextUrl.clone();
    url.pathname = path;
    if (options?.clearSearch) {
      url.search = "";
    }
    const response = NextResponse.redirect(url);
    copyResponseCookies(supabaseResponse, response);
    if (options?.clearStudioState) {
      clearStudioStateCookie(response, request);
      clearActiveStudioCookie(response, request);
    }
    if (options?.clearActiveStudio) {
      clearActiveStudioCookie(response, request);
    }
    return response;
  }

  function serviceUnavailable() {
    return redirectTo("/503");
  }

  if (!user) {
    clearStudioStateCookie(supabaseResponse, request);
    clearActiveStudioCookie(supabaseResponse, request);
    if (isAuthRoute) {
      return supabaseResponse;
    }
    return redirectTo("/login", { clearStudioState: true });
  }
  const authenticatedUserId = user.id;

  const studioStateCookie = parseStudioStateCookie(
    request.cookies.get(STUDIO_STATE_COOKIE)?.value
  );
  let hasStudio: boolean | null =
    studioStateCookie?.userId === authenticatedUserId ? studioStateCookie.hasStudio : null;
  membershipStatus =
    studioStateCookie?.userId === authenticatedUserId ? studioStateCookie.membershipStatus : null;
  if (membershipStatus === "archived") {
    hasStudio = false;
    clearActiveStudioCookie(supabaseResponse, request);
  }

  function cacheAuthProfile(profile: AuthProfileResponse) {
    authProfile = profile;
    membershipStatus = profile.membership_status;
    hasStudio = profile.membership_status === "active" && Boolean(profile.studio_id);
    setStudioStateCookie(
      supabaseResponse,
      request,
      authenticatedUserId,
      hasStudio,
      profile.membership_status
    );
    if (hasStudio && profile.studio_id) {
      setActiveStudioCookie(supabaseResponse, request, profile.studio_id);
    } else {
      clearActiveStudioCookie(supabaseResponse, request);
    }
  }

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

      cacheAuthProfile(parseAuthProfileResponse(await authMeResponse.json()));
    } catch (error) {
      console.error("Failed to resolve current user's studio in middleware", error);
      return serviceUnavailable();
    }
  }

  if (hasStudio === null) {
    return serviceUnavailable();
  }

  if (membershipStatus) {
    const membershipRedirect = resolveMembershipRoute({
      authenticated: true,
      hasStudio,
      isAuthRoute,
      isOnboardingRoute,
      membershipStatus,
      pathname,
    });
    if (membershipRedirect) {
      return redirectTo(membershipRedirect, {
        clearActiveStudio: membershipStatus === "archived" || membershipRedirect === ACCOUNT_ARCHIVED_ROUTE,
      });
    }
  }

  if (isBillingRoute(pathname)) {
    if (!apiBaseUrl) {
      return serviceUnavailable();
    }

    if (!authProfile) {
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

        cacheAuthProfile(parseAuthProfileResponse(await authMeResponse.json()));
      } catch (error) {
        console.error("Failed to resolve billing route authorization", error);
        return serviceUnavailable();
      }
    }

    if (membershipStatus) {
      const membershipRedirect = resolveMembershipRoute({
        authenticated: true,
        hasStudio: Boolean(hasStudio),
        isAuthRoute,
        isOnboardingRoute,
        membershipStatus,
        pathname,
      });
      if (membershipRedirect) {
        return redirectTo(membershipRedirect, {
          clearActiveStudio: membershipStatus === "archived" || membershipRedirect === ACCOUNT_ARCHIVED_ROUTE,
        });
      }
    }

    const billingRole = (authProfile as AuthProfileResponse | null)?.role;
    if (!canAccessBillingRoute(pathname, billingRole)) {
      return redirectTo("/access-denied", { clearSearch: true });
    }
  }

  return supabaseResponse;
}
