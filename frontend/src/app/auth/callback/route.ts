import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolveAuthCallbackNextPath } from "@/lib/auth-callback";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const providerError = requestUrl.searchParams.get("error");
  if (providerError) {
    const errorCode = providerError === "access_denied" ? "access_denied" : "callback_failed";
    return NextResponse.redirect(new URL(`/login?error=${errorCode}`, requestUrl.origin));
  }
  const code = requestUrl.searchParams.get("code");
  const nextPath = resolveAuthCallbackNextPath(requestUrl.searchParams.get("next"));

  const response = NextResponse.redirect(new URL(nextPath, requestUrl.origin));
  response.headers.set("Cache-Control", "private, no-store");

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", requestUrl.origin));
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    response.headers.set(
      "Location",
      new URL("/login?error=callback_failed", requestUrl.origin).href,
    );
    return response;
  }

  return response;
}
