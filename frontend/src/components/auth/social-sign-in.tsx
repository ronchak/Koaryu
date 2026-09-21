"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getAuthCallbackUrl } from "@/lib/auth-redirect";
import { Button } from "@/components/ui/button";

export function SocialSignIn({
  disabled,
  onLoadingChange,
}: {
  disabled: boolean;
  onLoadingChange: (loading: boolean) => void;
}) {
  const pending = useRef(false);
  const [loading, setLoading] = useState<"google" | "azure" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    function restoreAfterNavigation(event: PageTransitionEvent) {
      if (!event.persisted) return;
      pending.current = false;
      setLoading(null);
      onLoadingChange(false);
    }
    window.addEventListener("pageshow", restoreAfterNavigation);
    return () => window.removeEventListener("pageshow", restoreAfterNavigation);
  }, [onLoadingChange]);

  async function signIn(provider: "google" | "azure") {
    if (pending.current || disabled) return;
    pending.current = true;
    setLoading(provider);
    onLoadingChange(true);
    setError("");
    try {
      if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
        throw new Error("Social sign-in requires live authentication.");
      }
      const { error: authError } = await createClient().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: getAuthCallbackUrl(),
          ...(provider === "azure" ? { scopes: "email profile" } : {}),
          queryParams: { prompt: "select_account" },
        },
      });
      if (authError) throw authError;
    } catch {
      const name = provider === "azure" ? "Microsoft" : "Google";
      setError(`${name} sign-in couldn't start. Please try again or sign in with email.`);
      pending.current = false;
      setLoading(null);
      onLoadingChange(false);
    }
  }

  return (
    <div className="mb-5">
      <Button
        type="button"
        size="lg"
        disabled={disabled}
        isLoading={loading === "google"}
        onClick={() => signIn("google")}
        className="w-full min-h-11 bg-white text-[#1f1f1f] border border-[#747775] hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48">
          <path
            fill="#4285F4"
            d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.42h11a9.4 9.4 0 0 1-4.08 6.18v5.14h6.6c3.86-3.55 6.09-8.78 6.09-14.82Z"
          />
          <path
            fill="#34A853"
            d="M24 44c5.51 0 10.13-1.83 13.51-4.97l-6.6-5.14c-1.83 1.23-4.17 1.96-6.91 1.96-5.32 0-9.83-3.59-11.44-8.42H5.74v5.3A20 20 0 0 0 24 44Z"
          />
          <path
            fill="#FBBC05"
            d="M12.56 27.43a12 12 0 0 1 0-6.86v-5.3H5.74a20 20 0 0 0 0 17.46l6.82-5.3Z"
          />
          <path
            fill="#EA4335"
            d="M24 12.15c3 0 5.68 1.03 7.8 3.06l5.85-5.85A19.6 19.6 0 0 0 24 4 20 20 0 0 0 5.74 15.27l6.82 5.3C14.17 15.74 18.68 12.15 24 12.15Z"
          />
        </svg>
        Continue with Google
      </Button>
      <Button
        type="button"
        size="lg"
        disabled={disabled}
        isLoading={loading === "azure"}
        onClick={() => signIn("azure")}
        className="mt-3 w-full min-h-11 bg-white text-[#1f1f1f] border border-[#747775] hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 21 21">
          <path fill="#f25022" d="M1 1h9v9H1z" />
          <path fill="#00a4ef" d="M1 11h9v9H1z" />
          <path fill="#7fba00" d="M11 1h9v9h-9z" />
          <path fill="#ffb900" d="M11 11h9v9h-9z" />
        </svg>
        Sign in with Microsoft
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        <span>or continue with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
