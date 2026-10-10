"use client";

import { publishAccessIdentity } from "@/lib/access-identity";
import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { getAuthCallbackUrl } from "@/lib/auth-redirect";
import { ACCOUNT_ARCHIVED_ROUTE } from "@/lib/auth-route-model";
import { parseAuthProfileResponse } from "@/lib/store-bootstrap-model";
import { syncStoredStudioSessionCookies } from "@/lib/store-session-cookies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LegalConsentNotice } from "@/components/auth/legal-consent-notice";
import { SocialSignIn } from "@/components/auth/social-sign-in";
import { CallbackError } from "@/components/auth/callback-error";
import { authErrorClassName } from "@/components/auth/auth-messages";
import {
  SceneFootnote,
  SceneIntro,
  SceneSheet,
  SceneSplit,
  sceneLinkClassName,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<"password" | "magic-link">("password");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 500);
      return;
    }

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setIsLoading(false);
      return;
    }

    const session = data.session;
    if (!session) {
      setError("Signed in, but no session was returned. Please try again.");
      setIsLoading(false);
      return;
    }

    try {
      const authProfile = parseAuthProfileResponse(await api.get<unknown>(
        "/auth/me",
        session.access_token,
        { omitStudioHeader: true }
      ));
      publishAccessIdentity(authProfile);
      syncStoredStudioSessionCookies(
        session.user.id,
        authProfile.studio_id,
        authProfile.membership_status
      );
      const destination = authProfile.membership_status === "archived"
        ? ACCOUNT_ARCHIVED_ROUTE
        : authProfile.membership_status === "active"
          ? "/dashboard"
          : "/onboarding";
      router.push(destination);
      router.refresh();
    } catch (postLoginError) {
      const message =
        postLoginError instanceof Error
          ? postLoginError.message
          : "Signed in, but failed to load your studio.";
      setError(message);
      setIsLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      setTimeout(() => {
        setMagicLinkSent(true);
        setIsLoading(false);
      }, 500);
      return;
    }

    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: getAuthCallbackUrl(),
      },
    });

    if (authError) {
      setError(authError.message);
      setIsLoading(false);
      return;
    }

    setMagicLinkSent(true);
    setIsLoading(false);
  }

  if (magicLinkSent) {
    return (
      <SceneSplit>
        <SceneIntro
          eyebrow="Sign in"
          title="Your link is on its way."
          lede="Open the link on this device to finish signing in to your studio."
        />
        <SceneSheet labelledBy="magic-link-sent-title">
          <h2 id="magic-link-sent-title" className={sceneSheetTitleClassName}>
            Check your email
          </h2>
          <p className={sceneSheetLedeClassName}>
            We sent a sign-in link to{" "}
            <span className="font-semibold text-text-primary break-all">{email}</span>.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="mt-6 w-full"
            onClick={() => {
              setMagicLinkSent(false);
              setMode("password");
            }}
          >
            Back to sign in
          </Button>
        </SceneSheet>
      </SceneSplit>
    );
  }

  return (
    <SceneSplit>
      <SceneIntro
        eyebrow="Sign in"
        title="Welcome back to the mat."
        titleId="login-title"
        lede="Today's classes, follow-ups and belt promotions are waiting where you left them."
      />
      <SceneSheet labelledBy="login-title">
        <Suspense fallback={null}>
          <CallbackError />
        </Suspense>
        <SocialSignIn disabled={isLoading} onLoadingChange={setIsLoading} />

        {mode === "password" ? (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="you@yourstudio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            {error && <p className={authErrorClassName}>{error}</p>}

            <Button type="submit" variant="primary" size="lg" isLoading={isLoading} className="w-full">
              Sign in
            </Button>
          </form>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="you@yourstudio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              hint="We'll email you a one-time link instead of asking for a password."
            />

            {error && <p className={authErrorClassName}>{error}</p>}

            <Button type="submit" variant="primary" size="lg" isLoading={isLoading} className="w-full">
              Send magic link
            </Button>
          </form>
        )}

        {/* Mode toggle */}
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setMode(mode === "password" ? "magic-link" : "password")}
            className="min-h-11 cursor-pointer rounded-[10px] px-3 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
          >
            {mode === "password"
              ? "Sign in with magic link instead"
              : "Sign in with password instead"}
          </button>
        </div>

        <LegalConsentNotice action="continuing" />

        <SceneFootnote>
          New to Koaryu?{" "}
          <Link href="/signup" className={sceneLinkClassName}>
            Start free trial
          </Link>
        </SceneFootnote>
      </SceneSheet>
    </SceneSplit>
  );
}
