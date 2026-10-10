"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getAuthCallbackUrl } from "@/lib/auth-redirect";
import { clearActiveStudioIdCookie, setStudioStateCookie } from "@/lib/studio-state-cookie";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LegalConsentNotice } from "@/components/auth/legal-consent-notice";
import { SocialSignIn } from "@/components/auth/social-sign-in";
import { authErrorClassName, authNoticeClassName } from "@/components/auth/auth-messages";
import {
  SceneFootnote,
  SceneIntro,
  SceneSheet,
  SceneSplit,
  SceneSteps,
  TRIAL_STEPS,
  sceneLinkClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";
import { PUBLIC_PLATFORM_TRIAL_DAYS, formatPublicPlatformPrice } from "@/lib/constants";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setConfirmPasswordError("");

    if (password !== confirmPassword) {
      setConfirmPasswordError(
        "Passwords do not match. Please enter the same password in both fields.",
      );
      return;
    }

    setIsLoading(true);

    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("koaryu:previewSignupEmail", email);
        window.localStorage.setItem("koaryu:previewSignupName", fullName);
      }
      setTimeout(() => {
        router.push("/onboarding");
        router.refresh();
      }, 500);
      return;
    }

    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo: getAuthCallbackUrl(),
      },
    });

    if (authError) {
      setError(authError.message);
      setIsLoading(false);
      return;
    }

    if (!data.session) {
      setNotice(
        "Check your email to confirm your account, then sign in to finish setting up your studio.",
      );
      setIsLoading(false);
      return;
    }

    setStudioStateCookie(data.session.user.id, false);
    clearActiveStudioIdCookie();

    // After signup, redirect to onboarding to create their studio
    router.push("/onboarding");
    router.refresh();
  }

  return (
    <SceneSplit>
      <SceneIntro
        eyebrow="Start free trial"
        title="Run the school. Teach the art."
        titleId="signup-title"
        lede={`Three short steps to your studio. ${PUBLIC_PLATFORM_TRIAL_DAYS} days free, then ${formatPublicPlatformPrice()} a month per studio.`}
      >
        <SceneSteps label="Sign-up steps" current={0} steps={TRIAL_STEPS} />
        <p className="mt-6 text-sm text-text-secondary">
          Not ready yet?{" "}
          <Link href="/try" className={sceneLinkClassName}>
            Try the demo
          </Link>
        </p>
      </SceneIntro>
      <SceneSheet labelledBy="signup-sheet-title">
        <h2 id="signup-sheet-title" className={`${sceneSheetTitleClassName} mb-5`}>
          Create your account
        </h2>

        <SocialSignIn disabled={isLoading} onLoadingChange={setIsLoading} />

        <form onSubmit={handleSignup} className="space-y-4">
          <Input
            label="Full name"
            type="text"
            placeholder="Alex Tanaka"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            autoComplete="name"
          />
          <Input
            label="Email"
            type="email"
            placeholder="you@yourstudio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Password"
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setConfirmPasswordError("");
              }}
              required
              minLength={8}
              autoComplete="new-password"
            />
            <Input
              label="Confirm password"
              type="password"
              placeholder="Re-enter it"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setConfirmPasswordError("");
              }}
              required
              autoComplete="new-password"
              error={confirmPasswordError}
            />
          </div>

          {error && <p className={authErrorClassName}>{error}</p>}
          {notice && <p className={authNoticeClassName}>{notice}</p>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            isLoading={isLoading}
            className="w-full"
          >
            Create account
          </Button>
        </form>

        <LegalConsentNotice action="creating an account or continuing with Google or Microsoft" />

        <SceneFootnote>
          Already have an account?{" "}
          <Link href="/login" className={sceneLinkClassName}>
            Sign in
          </Link>
        </SceneFootnote>
      </SceneSheet>
    </SceneSplit>
  );
}
