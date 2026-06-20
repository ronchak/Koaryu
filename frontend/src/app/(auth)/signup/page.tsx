"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getAuthCallbackUrl } from "@/lib/auth-redirect";
import { clearActiveStudioIdCookie, setStudioStateCookie } from "@/lib/studio-state-cookie";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      setConfirmPasswordError("Passwords do not match. Please enter the same password in both fields.");
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
      setNotice("Check your email to confirm your account, then sign in to finish setting up your studio.");
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
    <div>
      <h2 className="text-lg font-semibold text-text-primary mb-1">
        Create your account
      </h2>
      <p className="text-sm text-text-secondary mb-5">
        Set up your studio in under two minutes.
      </p>

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
          placeholder="Re-enter your password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            setConfirmPasswordError("");
          }}
          required
          autoComplete="new-password"
          error={confirmPasswordError}
        />

        {error && (
          <p className="text-xs text-danger">{error}</p>
        )}
        {notice && (
          <p className="text-xs text-success">{notice}</p>
        )}

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

      {/* Login link */}
      <div className="mt-5 pt-5 border-t border-border text-center">
        <p className="text-sm text-text-secondary">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
